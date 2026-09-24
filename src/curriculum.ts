import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { pool } from './db.js';
import { logger } from './logger.js';
import { poolLookbackHours, percentScope as configuredPercentScope, type PercentScope } from './config.js';

/**
 * Curriculum: Subject → Track → Credit → Hour.
 *
 * A student's position is one HOUR per track. Selection draws only from the
 * hours at or before that position (see getHourPool and selection.ts), so a
 * student is never served content they have not been taught.
 *
 * Hours are flat: 1..total_hours within a credit, and the hour number IS the
 * position. Hours per credit vary and are stored per credit (credits.total_hours)
 * rather than assumed, so a new figure is data, not a code change.
 *
 * Projects are not part of this chain. Where the SME groups hours under a project
 * heading, that grouping is carried as hours.project_label for display only —
 * never read by selection, ordering or the pool.
 */

// ---------------------------------------------------------------------------
// Definition format + loader
// ---------------------------------------------------------------------------

const DefinitionSchema = z
  .object({
    subject: z.string().min(1).max(60),
    track: z.string().min(1).max(120),
    display_order: z.number().int().min(0).default(1),
    active: z.boolean().default(true),
    credits: z
      .array(
        z
          .object({
            code: z.string().min(1).max(20),
            name: z.string().max(160).nullable().optional(),
            total_hours: z.number().int().min(1).max(1000),
            // Optional per-hour detail, in hour order. Titles and project labels
            // are display only; the hour NUMBER is its position.
            hours: z
              .array(
                z.object({
                  title: z.string().max(200).nullable().optional(),
                  project_label: z.string().max(120).nullable().optional(),
                })
              )
              .optional(),
          })
          .superRefine((c, ctx) => {
            // The count is the contract between the SME's material and the
            // schedule. A list that disagrees with it is a mistake in one of the
            // two, and guessing which would put students on the wrong hour.
            if (c.hours && c.hours.length !== c.total_hours) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['hours'],
                message:
                  `credit ${c.code} declares total_hours ${c.total_hours} but lists ${c.hours.length} hour(s); ` +
                  `the list must have exactly total_hours entries`,
              });
            }
          })
      )
      .min(1),
  })
  .refine((d) => new Set(d.credits.map((c) => c.code)).size === d.credits.length, {
    message: 'credit codes must be unique within a track',
  });

export type CurriculumDefinition = z.input<typeof DefinitionSchema>;

export interface LoadReport {
  trackId: number;
  created: { tracks: number; credits: number; hours: number };
  updated: number;
  removed: number;
  noop: boolean;
}

/** Load a track definition from a JSON file. See loadCurriculumDefinition. */
export async function loadCurriculum(definitionFile: string): Promise<LoadReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(definitionFile, 'utf8'));
  } catch (err: any) {
    throw new Error(`cannot read curriculum definition ${definitionFile}: ${err?.message ?? err}`);
  }
  return loadCurriculumDefinition(raw);
}

/**
 * Create or update a track's credits and hours from a definition. Idempotent: an
 * identical definition writes nothing.
 *
 * Refuses to remove a credit, and refuses to shrink a credit whose disappearing
 * hours carry missions or student positions — restructuring live curriculum is a
 * deliberate migration, not a side effect of re-running a loader. Shrinking a
 * credit whose extra hours are empty is allowed and reported.
 *
 * Before committing, every credit's hour rows are counted against its
 * total_hours. A mismatch is an error: a credit that claims 24 hours and holds 23
 * would silently cap every student at 23 and skew every derived position.
 */
export async function loadCurriculumDefinition(input: unknown): Promise<LoadReport> {
  const def = DefinitionSchema.parse(input);
  const created = { tracks: 0, credits: 0, hours: 0 };
  let updated = 0;
  let removed = 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Track.
    const [[track]] = await conn.query<any[]>(
      `SELECT id, display_order, active FROM tracks WHERE subject = ? AND name = ? FOR UPDATE`,
      [def.subject, def.track]
    );
    let trackId: number;
    if (!track) {
      const [ins] = await conn.query<any>(
        `INSERT INTO tracks (subject, name, display_order, active) VALUES (?, ?, ?, ?)`,
        [def.subject, def.track, def.display_order, def.active]
      );
      trackId = Number(ins.insertId);
      created.tracks++;
    } else {
      trackId = Number(track.id);
      if (Number(track.display_order) !== def.display_order || Boolean(track.active) !== def.active) {
        await conn.query(`UPDATE tracks SET display_order = ?, active = ? WHERE id = ?`, [
          def.display_order,
          def.active,
          trackId,
        ]);
        updated++;
      }
    }

    // Credits.
    const [creditRows] = await conn.query<any[]>(
      `SELECT id, code, name, sequence, total_hours FROM credits WHERE track_id = ? ORDER BY sequence`,
      [trackId]
    );
    const creditBySeq = new Map<number, any>(creditRows.map((r) => [Number(r.sequence), r]));
    const extraCredit = creditRows.find((r) => Number(r.sequence) > def.credits.length);
    if (extraCredit) {
      throw new Error(
        `definition for "${def.track}" has ${def.credits.length} credits but the database has ${extraCredit.code} ` +
          `at sequence ${extraCredit.sequence}; removing curriculum is not supported by the loader`
      );
    }

    for (let ci = 0; ci < def.credits.length; ci++) {
      const c = def.credits[ci];
      const creditSeq = ci + 1;
      const name = c.name ?? null;
      let creditId: number;
      const existing = creditBySeq.get(creditSeq);
      if (!existing) {
        const [ins] = await conn.query<any>(
          `INSERT INTO credits (track_id, code, name, sequence, total_hours) VALUES (?, ?, ?, ?, ?)`,
          [trackId, c.code, name, creditSeq, c.total_hours]
        );
        creditId = Number(ins.insertId);
        created.credits++;
      } else {
        creditId = Number(existing.id);
        if (
          existing.code !== c.code ||
          (existing.name ?? null) !== name ||
          Number(existing.total_hours) !== c.total_hours
        ) {
          await conn.query(`UPDATE credits SET code = ?, name = ?, total_hours = ? WHERE id = ?`, [
            c.code,
            name,
            c.total_hours,
            creditId,
          ]);
          updated++;
        }
      }

      // Hours: 1..total_hours, flat.
      const [hourRows] = await conn.query<any[]>(
        `SELECT id, hour_number, title, project_label FROM hours WHERE credit_id = ? ORDER BY hour_number`,
        [creditId]
      );
      const hourByNumber = new Map<number, any>(hourRows.map((r) => [Number(r.hour_number), r]));

      // Shrinking: only when the hours going away carry nothing.
      const doomed = hourRows.filter((r) => Number(r.hour_number) > c.total_hours);
      if (doomed.length > 0) {
        const ids = doomed.map((r) => Number(r.id));
        const [[refs]] = await conn.query<any[]>(
          `SELECT (SELECT COUNT(*) FROM missions WHERE hour_id IN (?)) AS missions,
                  (SELECT COUNT(*) FROM student_positions WHERE hour_id IN (?)) AS positions`,
          [ids, ids]
        );
        if (Number(refs.missions) > 0 || Number(refs.positions) > 0) {
          throw new Error(
            `${c.code} would shrink from ${hourRows.length} to ${c.total_hours} hours, but hour(s) ` +
              `${doomed.map((r) => r.hour_number).join(', ')} carry ${refs.missions} mission(s) and ` +
              `${refs.positions} student position(s); removing taught hours is not supported by the loader`
          );
        }
        await conn.query(`DELETE FROM hours WHERE id IN (?)`, [ids]);
        removed += doomed.length;
      }

      for (let n = 1; n <= c.total_hours; n++) {
        const detail = c.hours?.[n - 1];
        const title = detail?.title ?? null;
        const label = detail?.project_label ?? null;
        const existingH = hourByNumber.get(n);
        if (!existingH) {
          await conn.query(`INSERT INTO hours (credit_id, hour_number, title, project_label) VALUES (?, ?, ?, ?)`, [
            creditId,
            n,
            title,
            label,
          ]);
          created.hours++;
        } else if (detail && ((existingH.title ?? null) !== title || (existingH.project_label ?? null) !== label)) {
          await conn.query(`UPDATE hours SET title = ?, project_label = ? WHERE id = ?`, [title, label, existingH.id]);
          updated++;
        }
      }
    }

    // The count check, on the committed-to state and inside the transaction: a
    // credit whose rows disagree with its total never reaches the database.
    await assertHourCounts(trackId, conn);

    await conn.commit();
    const noop = updated === 0 && removed === 0 && Object.values(created).every((n) => n === 0);
    logger.info(
      { subject: def.subject, track: def.track, trackId, created, updated, removed, noop },
      'curriculum loaded'
    );
    return { trackId, created, updated, removed, noop };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

type Runner = Pick<PoolConnection, 'query'>;

/**
 * Every credit on the track must hold exactly total_hours hour rows, numbered
 * 1..total_hours with no gaps. Throws naming both numbers. Called by the loader
 * before it commits, and available to anything that wants to check a database it
 * did not load itself.
 */
export async function assertHourCounts(trackId: number, conn: Runner = pool): Promise<void> {
  const [rows] = await conn.query<any[]>(
    `SELECT c.code, c.total_hours,
            (SELECT COUNT(*) FROM hours h WHERE h.credit_id = c.id) AS hour_rows,
            (SELECT COUNT(*) FROM hours h WHERE h.credit_id = c.id AND h.hour_number BETWEEN 1 AND c.total_hours)
              AS in_range
       FROM credits c
      WHERE c.track_id = ?
      ORDER BY c.sequence`,
    [trackId]
  );
  for (const r of rows) {
    const total = Number(r.total_hours);
    if (Number(r.hour_rows) !== total || Number(r.in_range) !== total) {
      throw new Error(
        `credit ${r.code} declares total_hours ${total} but has ${r.hour_rows} hour row(s) ` +
          `(${r.in_range} of them numbered 1..${total}); the hour rows and total_hours must agree exactly`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function findTrack(subject: string, name: string, conn: Runner = pool): Promise<number | null> {
  const [[row]] = await conn.query<any[]>(`SELECT id FROM tracks WHERE subject = ? AND name = ?`, [subject, name]);
  return row ? Number(row.id) : null;
}

/** Hour id for (track, credit code, hour number), or null. */
export async function findHour(
  trackId: number,
  creditCode: string,
  hourNumber: number,
  conn: Runner = pool
): Promise<number | null> {
  const [[row]] = await conn.query<any[]>(
    `SELECT h.id
       FROM hours h
       JOIN credits c ON c.id = h.credit_id
      WHERE c.track_id = ? AND c.code = ? AND h.hour_number = ?`,
    [trackId, creditCode, hourNumber]
  );
  return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export type PositionSource = 'explicit' | 'derived_percent' | 'manual';

export interface StudentPosition {
  studentId: number;
  trackId: number;
  creditId: number;
  creditCode: string;
  creditSeq: number;
  creditTotalHours: number;
  hourId: number;
  hourNumber: number;
  hourTitle: string | null;
  projectLabel: string | null;
  source: PositionSource;
  sourceDetail: any;
}

function parseJson(raw: unknown): any {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

export async function getPosition(
  studentId: number,
  trackId: number,
  conn: Runner = pool
): Promise<StudentPosition | null> {
  const [[r]] = await conn.query<any[]>(
    `SELECT sp.student_id, sp.track_id, sp.credit_id, c.code AS credit_code, c.sequence AS credit_seq,
            c.total_hours, h.id AS hour_id, h.hour_number, h.title AS hour_title, h.project_label,
            sp.source, sp.source_detail
       FROM student_positions sp
       JOIN hours h ON h.id = sp.hour_id
       JOIN credits c ON c.id = h.credit_id
      WHERE sp.student_id = ? AND sp.track_id = ?`,
    [studentId, trackId]
  );
  if (!r) return null;
  return {
    studentId: Number(r.student_id),
    trackId: Number(r.track_id),
    creditId: Number(r.credit_id),
    creditCode: r.credit_code,
    creditSeq: Number(r.credit_seq),
    creditTotalHours: Number(r.total_hours),
    hourId: Number(r.hour_id),
    hourNumber: Number(r.hour_number),
    hourTitle: r.hour_title ?? null,
    projectLabel: r.project_label ?? null,
    source: r.source,
    sourceDetail: parseJson(r.source_detail),
  };
}

/**
 * Store a student's position directly. credit_id is derived from the hour so the
 * row can never disagree with itself, and the hour must belong to the track.
 */
export async function setPosition(
  studentId: number,
  trackId: number,
  hourId: number,
  source: PositionSource = 'explicit',
  sourceDetail: unknown = null,
  conn: Runner = pool
): Promise<StudentPosition> {
  const [[h]] = await conn.query<any[]>(
    `SELECT c.id AS credit_id, c.track_id FROM hours h JOIN credits c ON c.id = h.credit_id WHERE h.id = ?`,
    [hourId]
  );
  if (!h) throw new Error(`hour ${hourId} not found`);
  if (Number(h.track_id) !== trackId) {
    throw new Error(`hour ${hourId} belongs to track ${h.track_id}, not track ${trackId}`);
  }
  await conn.query(
    `INSERT INTO student_positions (student_id, track_id, credit_id, hour_id, source, source_detail)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE credit_id = VALUES(credit_id), hour_id = VALUES(hour_id),
                             source = VALUES(source), source_detail = VALUES(source_detail)`,
    [
      studentId,
      trackId,
      Number(h.credit_id),
      hourId,
      source,
      sourceDetail == null ? null : JSON.stringify(sourceDetail),
    ]
  );
  logger.info({ studentId, trackId, hourId, source }, 'student position set');
  return (await getPosition(studentId, trackId, conn))!;
}

/**
 * Hour number for a completion percentage over `total` hours.
 *
 * Rounds DOWN — a student at 39% of a 24-hour credit is on hour 9, never 10 — and
 * clamps to [1, total], so 0% is hour 1 rather than "no hour". Never give a
 * student content they have not reached.
 *
 * Integer arithmetic on basis points, so 29% of 100 hours is exactly 29 rather
 * than 28.999… floored to 28. Precision: 0.01%.
 */
export function hourNumberFromPercent(percent: number, total: number): { raw: number; hour: number } {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`completion percentage must be between 0 and 100 (got ${percent})`);
  }
  if (!Number.isInteger(total) || total < 1) throw new Error(`total hours must be a positive integer (got ${total})`);
  const basisPoints = Math.round(percent * 100);
  const raw = Math.floor((basisPoints * total) / 10000);
  return { raw, hour: Math.min(Math.max(raw, 1), total) };
}

export interface DerivedPosition {
  hourId: number;
  hourNumber: number;
  creditId: number;
  percent: number;
  scope: PercentScope;
  total: number;
  rawIndex: number;
  index: number;
  basis: { creditId?: number; defaulted: boolean };
}

/**
 * Map an LMS completion percentage to an hour under the given scope:
 *   credit — percent of that credit's total_hours (context.creditId, else the
 *            first credit). This is the default and what the LMS profile means.
 *   track  — percent of every hour in the track, in curriculum order.
 * The basis is part of the result and of the log line, so a wrong scope or a
 * defaulted credit is visible rather than silent.
 */
export async function derivePositionFromPercent(
  percent: number,
  scope: PercentScope,
  trackId: number,
  context: { creditId?: number } = {},
  conn: Runner = pool
): Promise<DerivedPosition> {
  const basis: DerivedPosition['basis'] = { defaulted: false };

  if (scope === 'credit') {
    let creditId = context.creditId;
    if (creditId == null) {
      const [[first]] = await conn.query<any[]>(`SELECT id FROM credits WHERE track_id = ? ORDER BY sequence LIMIT 1`, [
        trackId,
      ]);
      if (!first) throw new Error(`track ${trackId} has no credits`);
      creditId = Number(first.id);
      basis.defaulted = true;
    }
    basis.creditId = creditId;
    const [[credit]] = await conn.query<any[]>(`SELECT id, total_hours FROM credits WHERE id = ? AND track_id = ?`, [
      creditId,
      trackId,
    ]);
    if (!credit) throw new Error(`credit ${creditId} is not in track ${trackId}`);
    const total = Number(credit.total_hours);
    // The total comes from the CREDIT, not from a row count: two credits with
    // different totals must derive different hours from the same percentage.
    const { raw, hour } = hourNumberFromPercent(percent, total);
    const hourId = await requireHour(Number(credit.id), hour, conn);
    const result: DerivedPosition = {
      hourId,
      hourNumber: hour,
      creditId: Number(credit.id),
      percent,
      scope,
      total,
      rawIndex: raw,
      index: hour,
      basis,
    };
    logger.info({ trackId, ...result }, 'position derived from LMS percent');
    return result;
  }

  // track: walk the credits in order, spending the derived index across each
  // credit's total_hours.
  const [credits] = await conn.query<any[]>(
    `SELECT id, total_hours FROM credits WHERE track_id = ? ORDER BY sequence`,
    [trackId]
  );
  if (credits.length === 0) throw new Error(`track ${trackId} has no credits`);
  const total = credits.reduce((sum, c) => sum + Number(c.total_hours), 0);
  if (total < 1) throw new Error(`track ${trackId} has no hours`);
  const { raw, hour: index } = hourNumberFromPercent(percent, total);
  let remaining = index;
  for (const c of credits) {
    const hours = Number(c.total_hours);
    if (remaining <= hours) {
      const hourId = await requireHour(Number(c.id), remaining, conn);
      const result: DerivedPosition = {
        hourId,
        hourNumber: remaining,
        creditId: Number(c.id),
        percent,
        scope,
        total,
        rawIndex: raw,
        index,
        basis,
      };
      logger.info({ trackId, ...result }, 'position derived from LMS percent');
      return result;
    }
    remaining -= hours;
  }
  /* c8 ignore next */
  throw new Error(`could not place index ${index} of ${total} hours in track ${trackId}`);
}

/** The hour row for (credit, number). Missing means the credit's rows disagree with its total. */
async function requireHour(creditId: number, hourNumber: number, conn: Runner): Promise<number> {
  const [[row]] = await conn.query<any[]>(`SELECT id FROM hours WHERE credit_id = ? AND hour_number = ?`, [
    creditId,
    hourNumber,
  ]);
  if (!row) {
    throw new Error(
      `credit ${creditId} has no hour ${hourNumber}; its hour rows and total_hours disagree — reload the definition`
    );
  }
  return Number(row.id);
}

/**
 * The student's position on a track.
 *
 *  - An explicit or manual position always wins; a percentage never overwrites it.
 *  - With no stored position and no percentage: null (the caller must not guess).
 *  - With a percentage: derive (PERCENT_SCOPE) when there is no row, or when the
 *    stored derived row is stale — a different percentage or a different scope.
 *    The derivation is written with source='derived_percent' and its inputs.
 */
export async function resolvePosition(
  studentId: number,
  trackId: number,
  opts: { percent?: number; context?: { creditId?: number } } = {}
): Promise<StudentPosition | null> {
  const current = await getPosition(studentId, trackId);
  if (current && current.source !== 'derived_percent') return current;
  if (opts.percent == null) return current;

  const scope = configuredPercentScope();
  const detail = current?.sourceDetail;
  if (current && detail && Number(detail.percent) === opts.percent && detail.scope === scope) return current;

  const context = opts.context ?? (current ? { creditId: current.creditId } : {});
  const derived = await derivePositionFromPercent(opts.percent, scope, trackId, context);
  logger.info(
    { studentId, trackId, previousHourId: current?.hourId ?? null, hourId: derived.hourId, scope },
    current ? 'derived position refreshed (stale)' : 'derived position created'
  );
  return setPosition(studentId, trackId, derived.hourId, 'derived_percent', {
    percent: derived.percent,
    scope: derived.scope,
    total: derived.total,
    raw_index: derived.rawIndex,
    index: derived.index,
    hour_number: derived.hourNumber,
    basis: derived.basis,
  });
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * current — the base pool (D1): the current hour plus POOL_LOOKBACK_HOURS earlier
 *           hours in the current credit (0 = all earlier hours in the credit)
 * credit  — every hour up to the position in the current credit (D3a)
 * track   — the whole completed curriculum: earlier credits plus the above (D3b)
 */
export type PoolTier = 'current' | 'credit' | 'track';

/**
 * Hour ids the student may draw from, ordered current first, then later hours
 * before earlier ones. Never includes an hour ahead of the position or in a later
 * credit — that ceiling is part of the SQL, for every tier.
 */
export async function getHourPool(
  studentId: number,
  trackId: number,
  opts: { tier?: PoolTier; conn?: Runner } = {}
): Promise<number[]> {
  const tier = opts.tier ?? 'current';
  const conn = opts.conn ?? pool;
  const params: any[] = [studentId, trackId];
  let tierClause: string;
  if (tier === 'current') {
    const lookback = poolLookbackHours();
    if (lookback > 0) {
      tierClause = 'AND c.id = pc.id AND h.hour_number + ? >= ph.hour_number';
      params.push(lookback);
    } else {
      tierClause = 'AND c.id = pc.id';
    }
  } else if (tier === 'credit') {
    tierClause = 'AND c.id = pc.id';
  } else {
    tierClause = '';
  }

  const [rows] = await conn.query<any[]>(
    `SELECT h.id
       FROM student_positions sp
       JOIN tracks t ON t.id = sp.track_id AND t.active = TRUE
       JOIN hours ph ON ph.id = sp.hour_id
       JOIN credits pc ON pc.id = ph.credit_id
       JOIN credits c ON c.track_id = sp.track_id
       JOIN hours h ON h.credit_id = c.id
      WHERE sp.student_id = ? AND sp.track_id = ?
        AND (c.sequence < pc.sequence OR (c.id = pc.id AND h.hour_number <= ph.hour_number))
        ${tierClause}
      ORDER BY (h.id = sp.hour_id) DESC, c.sequence DESC, h.hour_number DESC`,
    params
  );
  return rows.map((r) => Number(r.id));
}

// ---------------------------------------------------------------------------
// CLI:  npm run curriculum:load -- <definition.json>
// ---------------------------------------------------------------------------
// Exact filename, not a suffix: a suffix match also catches verify-curriculum.mjs.
const isCli = process.argv[1] ? /^curriculum[.](ts|js|mjs)$/.test(basename(process.argv[1])) : false;
if (isCli) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'load' || !file) {
    process.stderr.write('usage: npm run curriculum:load -- <definition.json>\n');
    process.exit(2);
  }
  loadCurriculum(file)
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return pool.end();
    })
    .catch((err) => {
      logger.error({ err }, 'curriculum load failed');
      process.exit(1);
    });
}
