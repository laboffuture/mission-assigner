import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { pool } from './db.js';
import { logger } from './logger.js';
import { poolLookbackSessions, percentScope as configuredPercentScope, type PercentScope } from './config.js';

/**
 * Curriculum: Subject → Track → Credit → Project → Session.
 *
 * A student's position is one session per track. Selection draws only from the
 * sessions at or before that position (see getSessionPool and selection.ts), so
 * a student is never served content they have not been taught.
 *
 * credit_sequence is a session's running position within its credit across the
 * credit's projects in order (C1: P1 = 1..9, P2 = 10..17, P3 = 18..25).
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
        z.object({
          code: z.string().min(1).max(20),
          name: z.string().max(160).nullable().optional(),
          projects: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(200),
                  session_count: z.number().int().min(1),
                  sessions: z.array(z.object({ title: z.string().max(200).nullable().optional() })).optional(),
                })
                .refine((p) => !p.sessions || p.sessions.length === p.session_count, {
                  message: 'sessions[] length must equal session_count',
                })
            )
            .min(1),
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
  created: { tracks: number; credits: number; projects: number; sessions: number };
  updated: number;
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
 * Create or update a track's credits, projects and sessions from a definition,
 * computing credit_sequence. Idempotent: an identical definition writes nothing.
 *
 * Additive only. A definition that removes a credit or project, or shrinks a
 * project's session_count, is refused: missions and student positions reference
 * sessions, and restructuring a live curriculum is a deliberate migration, not a
 * side effect of re-running a loader.
 */
export async function loadCurriculumDefinition(input: unknown): Promise<LoadReport> {
  const def = DefinitionSchema.parse(input);
  const created = { tracks: 0, credits: 0, projects: 0, sessions: 0 };
  let updated = 0;

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
      `SELECT id, code, name, sequence FROM credits WHERE track_id = ? ORDER BY sequence`,
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
          `INSERT INTO credits (track_id, code, name, sequence) VALUES (?, ?, ?, ?)`,
          [trackId, c.code, name, creditSeq]
        );
        creditId = Number(ins.insertId);
        created.credits++;
      } else {
        creditId = Number(existing.id);
        if (existing.code !== c.code || (existing.name ?? null) !== name) {
          await conn.query(`UPDATE credits SET code = ?, name = ? WHERE id = ?`, [c.code, name, creditId]);
          updated++;
        }
      }

      warnIfUnusualShape(
        def.track,
        c.code,
        c.projects.map((p) => p.session_count)
      );

      // Projects.
      const [projectRows] = await conn.query<any[]>(
        `SELECT id, name, sequence, session_count FROM projects WHERE credit_id = ? ORDER BY sequence`,
        [creditId]
      );
      const projectBySeq = new Map<number, any>(projectRows.map((r) => [Number(r.sequence), r]));
      const extraProject = projectRows.find((r) => Number(r.sequence) > c.projects.length);
      if (extraProject) {
        throw new Error(
          `definition for ${c.code} has ${c.projects.length} projects but the database has project ` +
            `${extraProject.sequence}; removing curriculum is not supported by the loader`
        );
      }

      let creditSequence = 0;
      for (let pi = 0; pi < c.projects.length; pi++) {
        const p = c.projects[pi];
        const projectSeq = pi + 1;
        let projectId: number;
        const existingP = projectBySeq.get(projectSeq);
        if (!existingP) {
          const [ins] = await conn.query<any>(
            `INSERT INTO projects (credit_id, name, sequence, session_count) VALUES (?, ?, ?, ?)`,
            [creditId, p.name, projectSeq, p.session_count]
          );
          projectId = Number(ins.insertId);
          created.projects++;
        } else {
          projectId = Number(existingP.id);
          if (p.session_count < Number(existingP.session_count)) {
            throw new Error(
              `${c.code} project ${projectSeq} would shrink from ${existingP.session_count} to ${p.session_count} ` +
                `sessions; removing sessions is not supported by the loader`
            );
          }
          if (existingP.name !== p.name || Number(existingP.session_count) !== p.session_count) {
            await conn.query(`UPDATE projects SET name = ?, session_count = ? WHERE id = ?`, [
              p.name,
              p.session_count,
              projectId,
            ]);
            updated++;
          }
        }

        // Sessions.
        const [sessionRows] = await conn.query<any[]>(
          `SELECT id, sequence, credit_sequence, title FROM sessions WHERE project_id = ?`,
          [projectId]
        );
        const sessionBySeq = new Map<number, any>(sessionRows.map((r) => [Number(r.sequence), r]));
        for (let si = 1; si <= p.session_count; si++) {
          creditSequence++;
          const title = p.sessions?.[si - 1]?.title ?? null;
          const existingS = sessionBySeq.get(si);
          if (!existingS) {
            await conn.query(
              `INSERT INTO sessions (project_id, sequence, credit_sequence, title) VALUES (?, ?, ?, ?)`,
              [projectId, si, creditSequence, title]
            );
            created.sessions++;
          } else if (
            Number(existingS.credit_sequence) !== creditSequence ||
            (p.sessions && (existingS.title ?? null) !== title)
          ) {
            await conn.query(`UPDATE sessions SET credit_sequence = ?, title = ? WHERE id = ?`, [
              creditSequence,
              p.sessions ? title : (existingS.title ?? null),
              existingS.id,
            ]);
            updated++;
          }
        }
      }
    }

    await conn.commit();
    const noop = updated === 0 && Object.values(created).every((n) => n === 0);
    logger.info({ subject: def.subject, track: def.track, trackId, created, updated, noop }, 'curriculum loaded');
    return { trackId, created, updated, noop };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Current shape rule: first project of a credit has 9 sessions, the rest 8. Warn, don't enforce. */
function warnIfUnusualShape(track: string, creditCode: string, counts: number[]): void {
  const expected = counts.map((_, i) => (i === 0 ? 9 : 8));
  if (counts.some((n, i) => n !== expected[i])) {
    logger.warn(
      { track, credit: creditCode, sessionCounts: counts, expected },
      'curriculum shape differs from the usual 9-then-8 sessions per project'
    );
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

type Runner = Pick<PoolConnection, 'query'>;

export async function findTrack(subject: string, name: string, conn: Runner = pool): Promise<number | null> {
  const [[row]] = await conn.query<any[]>(`SELECT id FROM tracks WHERE subject = ? AND name = ?`, [subject, name]);
  return row ? Number(row.id) : null;
}

/** Session id for (track, credit code, project sequence, session sequence), or null. */
export async function findSession(
  trackId: number,
  creditCode: string,
  projectSeq: number,
  sessionSeq: number,
  conn: Runner = pool
): Promise<number | null> {
  const [[row]] = await conn.query<any[]>(
    `SELECT s.id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN credits c ON c.id = p.credit_id
      WHERE c.track_id = ? AND c.code = ? AND p.sequence = ? AND s.sequence = ?`,
    [trackId, creditCode, projectSeq, sessionSeq]
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
  projectId: number;
  projectSeq: number;
  sessionId: number;
  sessionSeq: number;
  creditSequence: number;
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
            p.id AS project_id, p.sequence AS project_seq, s.id AS session_id, s.sequence AS session_seq,
            s.credit_sequence, sp.source, sp.source_detail
       FROM student_positions sp
       JOIN sessions s ON s.id = sp.session_id
       JOIN projects p ON p.id = s.project_id
       JOIN credits c ON c.id = p.credit_id
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
    projectId: Number(r.project_id),
    projectSeq: Number(r.project_seq),
    sessionId: Number(r.session_id),
    sessionSeq: Number(r.session_seq),
    creditSequence: Number(r.credit_sequence),
    source: r.source,
    sourceDetail: parseJson(r.source_detail),
  };
}

/**
 * Store a student's position directly. credit_id is derived from the session so
 * the row can never disagree with itself, and the session must belong to the track.
 */
export async function setPosition(
  studentId: number,
  trackId: number,
  sessionId: number,
  source: PositionSource = 'explicit',
  sourceDetail: unknown = null,
  conn: Runner = pool
): Promise<StudentPosition> {
  const [[s]] = await conn.query<any[]>(
    `SELECT c.id AS credit_id, c.track_id
       FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
      WHERE s.id = ?`,
    [sessionId]
  );
  if (!s) throw new Error(`session ${sessionId} not found`);
  if (Number(s.track_id) !== trackId) {
    throw new Error(`session ${sessionId} belongs to track ${s.track_id}, not track ${trackId}`);
  }
  await conn.query(
    `INSERT INTO student_positions (student_id, track_id, credit_id, session_id, source, source_detail)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE credit_id = VALUES(credit_id), session_id = VALUES(session_id),
                             source = VALUES(source), source_detail = VALUES(source_detail)`,
    [
      studentId,
      trackId,
      Number(s.credit_id),
      sessionId,
      source,
      sourceDetail == null ? null : JSON.stringify(sourceDetail),
    ]
  );
  logger.info({ studentId, trackId, sessionId, source }, 'student position set');
  return (await getPosition(studentId, trackId, conn))!;
}

/**
 * Session index for a completion percentage over `total` ordered sessions.
 * Rounds DOWN — a student at 39% of 25 sessions is on session 9, never 10 — and
 * clamps to [1, total] (0% is the first session, not "no session").
 *
 * Integer arithmetic on basis points, so a value such as 29% of 100 sessions is
 * exactly 29 rather than 28.999… floored to 28. Precision: 0.01%.
 */
export function sessionIndexFromPercent(percent: number, total: number): { raw: number; index: number } {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`completion percentage must be between 0 and 100 (got ${percent})`);
  }
  if (!Number.isInteger(total) || total < 1) throw new Error(`session total must be a positive integer (got ${total})`);
  const basisPoints = Math.round(percent * 100);
  const raw = Math.floor((basisPoints * total) / 10000);
  return { raw, index: Math.min(Math.max(raw, 1), total) };
}

export interface DerivedPosition {
  sessionId: number;
  creditId: number;
  percent: number;
  scope: PercentScope;
  total: number;
  rawIndex: number;
  index: number;
  basis: { creditId?: number; projectId?: number; defaulted: boolean };
}

/**
 * Map an LMS completion percentage to a session under the given scope:
 *   credit  — percent of the sessions in one credit (context.creditId, else the first credit)
 *   project — percent of the sessions in one project (context.projectId, else the first project)
 *   track   — percent of every session in the track, in curriculum order
 * The scope's basis is part of the result and the log line, so a wrong scope or a
 * defaulted credit is visible rather than silent.
 */
export async function derivePositionFromPercent(
  percent: number,
  scope: PercentScope,
  trackId: number,
  context: { creditId?: number; projectId?: number } = {},
  conn: Runner = pool
): Promise<DerivedPosition> {
  let rows: any[];
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
    [rows] = await conn.query<any[]>(
      `SELECT s.id, c.id AS credit_id
         FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
        WHERE c.id = ? AND c.track_id = ?
        ORDER BY s.credit_sequence`,
      [creditId, trackId]
    );
  } else if (scope === 'project') {
    let projectId = context.projectId;
    if (projectId == null) {
      const [[first]] = await conn.query<any[]>(
        `SELECT p.id FROM projects p JOIN credits c ON c.id = p.credit_id
          WHERE c.track_id = ? ORDER BY c.sequence, p.sequence LIMIT 1`,
        [trackId]
      );
      if (!first) throw new Error(`track ${trackId} has no projects`);
      projectId = Number(first.id);
      basis.defaulted = true;
    }
    basis.projectId = projectId;
    [rows] = await conn.query<any[]>(
      `SELECT s.id, c.id AS credit_id
         FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
        WHERE p.id = ? AND c.track_id = ?
        ORDER BY s.sequence`,
      [projectId, trackId]
    );
  } else {
    [rows] = await conn.query<any[]>(
      `SELECT s.id, c.id AS credit_id
         FROM sessions s JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id
        WHERE c.track_id = ?
        ORDER BY c.sequence, s.credit_sequence`,
      [trackId]
    );
  }

  if (rows.length === 0) throw new Error(`no sessions found for scope ${scope} in track ${trackId}`);
  const { raw, index } = sessionIndexFromPercent(percent, rows.length);
  const chosen = rows[index - 1];
  const result: DerivedPosition = {
    sessionId: Number(chosen.id),
    creditId: Number(chosen.credit_id),
    percent,
    scope,
    total: rows.length,
    rawIndex: raw,
    index,
    basis,
  };
  logger.info({ trackId, ...result }, 'position derived from LMS percent');
  return result;
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
  opts: { percent?: number; context?: { creditId?: number; projectId?: number } } = {}
): Promise<StudentPosition | null> {
  const current = await getPosition(studentId, trackId);
  if (current && current.source !== 'derived_percent') return current;
  if (opts.percent == null) return current;

  const scope = configuredPercentScope();
  const detail = current?.sourceDetail;
  if (current && detail && Number(detail.percent) === opts.percent && detail.scope === scope) return current;

  const context = opts.context ?? (current ? { creditId: current.creditId, projectId: current.projectId } : {});
  const derived = await derivePositionFromPercent(opts.percent, scope, trackId, context);
  logger.info(
    { studentId, trackId, previousSessionId: current?.sessionId ?? null, sessionId: derived.sessionId, scope },
    current ? 'derived position refreshed (stale)' : 'derived position created'
  );
  return setPosition(studentId, trackId, derived.sessionId, 'derived_percent', {
    percent: derived.percent,
    scope: derived.scope,
    total: derived.total,
    raw_index: derived.rawIndex,
    index: derived.index,
    basis: derived.basis,
  });
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * current — the base pool (D1): the current session plus POOL_LOOKBACK_SESSIONS
 *           earlier sessions in the current credit (0 = all earlier in the credit)
 * credit  — every session up to the position in the current credit (D3a)
 * track   — the whole completed curriculum: earlier credits plus the above (D3b)
 */
export type PoolTier = 'current' | 'credit' | 'track';

/**
 * Session ids the student may draw from, ordered current first, then later
 * sessions before earlier ones. Never includes a session ahead of the position or
 * in a later credit — that ceiling is part of the SQL, for every tier.
 */
export async function getSessionPool(
  studentId: number,
  trackId: number,
  opts: { tier?: PoolTier; conn?: Runner } = {}
): Promise<number[]> {
  const tier = opts.tier ?? 'current';
  const conn = opts.conn ?? pool;
  const params: any[] = [studentId, trackId];
  let tierClause: string;
  if (tier === 'current') {
    const lookback = poolLookbackSessions();
    if (lookback > 0) {
      tierClause = 'AND c.id = pc.id AND s.credit_sequence + ? >= ps.credit_sequence';
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
    `SELECT s.id
       FROM student_positions sp
       JOIN tracks t ON t.id = sp.track_id AND t.active = TRUE
       JOIN sessions ps ON ps.id = sp.session_id
       JOIN projects pp ON pp.id = ps.project_id
       JOIN credits pc ON pc.id = pp.credit_id
       JOIN credits c ON c.track_id = sp.track_id
       JOIN projects p ON p.credit_id = c.id
       JOIN sessions s ON s.project_id = p.id
      WHERE sp.student_id = ? AND sp.track_id = ?
        AND (c.sequence < pc.sequence OR (c.id = pc.id AND s.credit_sequence <= ps.credit_sequence))
        ${tierClause}
      ORDER BY (s.id = sp.session_id) DESC, c.sequence DESC, s.credit_sequence DESC`,
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
