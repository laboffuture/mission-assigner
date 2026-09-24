import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db.js';
import { logger } from './logger.js';
import { selectionMode, poolLookbackHours, revisionMixPercent } from './config.js';
import { getHourPool, type PoolTier } from './curriculum.js';

export interface SelectionResult {
  assignmentId: number;
  missionId: number;
}

// ===========================================================================
// Curriculum selection (SELECTION_MODE=curriculum)
// ===========================================================================

export interface CurriculumQuery {
  studentId: number;
  subject: string;
  age: number;
  /** The level difficulty is ranked against (closest first). */
  targetLevel: number;
  /** Slot filters — set by slotFiller; omitted by free-play selection. */
  missionType?: string;
  timeBands?: string[];
}

export interface CurriculumCandidate {
  mission_id: number;
  mission_version: number;
  difficulty: number;
  hour_id: number;
  credit_code: string;
  hour_number: number;
  is_current_hour: boolean;
  overlap: number;
  revision_seq: number;
}

export type CurriculumTier = PoolTier | 'widen_band' | 'repeat_oldest';

/** Slot time bands, shortest first. Widening only ever goes UP. */
const TIME_BANDS = ['short', 'medium', 'long', 'heavy'];

/** The slot's band plus every longer one, for the D3 band-widening step. */
export function widenTimeBands(bands: string[]): string[] {
  const lowest = Math.min(...bands.map((b) => TIME_BANDS.indexOf(b)).filter((i) => i >= 0));
  if (!Number.isFinite(lowest)) return bands;
  return TIME_BANDS.slice(lowest);
}

export interface CurriculumChoice {
  chosen: CurriculumCandidate | null;
  revision: boolean;
  /** true when REVISION_MIX_PERCENT diverted this pick to an earlier hour. */
  revisionMix: boolean;
  tier: CurriculumTier | null;
  trackId: number | null;
  positionHourId: number | null;
  /** Ordered log of each relaxation step applied (D3). */
  relaxations: string[];
  poolSizes: Partial<Record<CurriculumTier, number>>;
  reason: 'no_track' | 'no_position' | 'exhausted' | null;
  candidates: CurriculumCandidate[];
}

/** Joins every candidate query shares: mission → its hour/credit, and the student's position. */
const CURRICULUM_JOINS = `
  FROM missions m
  JOIN hours h ON h.id = m.hour_id
  JOIN credits c ON c.id = h.credit_id
  JOIN student_positions sp ON sp.student_id = ? AND sp.track_id = c.track_id
  JOIN hours ph ON ph.id = sp.hour_id
  JOIN credits pc ON pc.id = ph.credit_id`;

/**
 * SAFETY — the curriculum ceiling, in SQL. A mission's hour must be in an
 * earlier credit of the track, or in the student's credit at or before their
 * hour. It is applied to every tier independently of the pool id list, so a
 * wrong pool can never surface content the student has not reached.
 */
const CEILING = `(c.sequence < pc.sequence OR (c.id = pc.id AND h.hour_number <= ph.hour_number))`;

function hardFilters(q: CurriculumQuery): { sql: string; params: any[] } {
  let sql = `AND m.status = 'live' AND m.subject = ? AND ? BETWEEN m.age_min AND m.age_max`;
  const params: any[] = [q.subject, q.age];
  if (q.missionType != null) {
    sql += ` AND m.mission_type = ?`;
    params.push(q.missionType);
  }
  if (q.timeBands && q.timeBands.length > 0) {
    sql += ` AND m.time_band IN (${q.timeBands.map(() => '?').join(', ')})`;
    params.push(...q.timeBands);
  }
  return { sql, params };
}

function toCandidate(r: any, revisionSeq = 0): CurriculumCandidate {
  return {
    mission_id: Number(r.mission_id),
    mission_version: Number(r.mission_version),
    difficulty: Number(r.difficulty),
    hour_id: Number(r.hour_id),
    credit_code: r.credit_code,
    hour_number: Number(r.hour_number),
    is_current_hour: Boolean(Number(r.is_current_hour)),
    overlap: Number(r.overlap),
    revision_seq: revisionSeq,
  };
}

/**
 * Choose a mission scoped to the student's curriculum position. Read-only: the
 * caller creates the assignment and writes selection_log.
 *
 * Filters, in order:
 *   1. HARD hour_id IN (pool)             + the SQL ceiling (never ahead)
 *   2. HARD status = 'live'
 *   3. HARD mission_type / time_band match the slot (when given)
 *   4. HARD not already assigned to this student
 *      (subject and age still apply; the track largely implies them)
 * Ranking:
 *   5. current hour first, then later hours before earlier ones
 *   6. difficulty closest to targetLevel
 *   7. interest-tag overlap
 *   8. random
 *
 * Exhaustion (D3), each step logged:
 *   a. widen to every earlier hour in the credit (only if lookback limited it)
 *   b. widen to earlier credits in the track
 *   c. repeat the completed mission seen longest ago, as revision
 *   d. empty
 *
 * `poolOverride` exists for the safety harness: it substitutes the id list so the
 * test can prove the SQL ceiling holds even when the pool is wrong.
 */
export async function chooseCurriculumMission(
  conn: Pick<PoolConnection, 'query'>,
  q: CurriculumQuery,
  opts: { poolOverride?: number[] } = {}
): Promise<CurriculumChoice> {
  const choice: CurriculumChoice = {
    chosen: null,
    revision: false,
    revisionMix: false,
    tier: null,
    trackId: null,
    positionHourId: null,
    relaxations: [],
    poolSizes: {},
    reason: null,
    candidates: [],
  };

  // Track: the student's position on an active track for their subject.
  const [[pos]] = await conn.query<any[]>(
    `SELECT sp.track_id, sp.hour_id
       FROM student_positions sp
       JOIN tracks t ON t.id = sp.track_id AND t.active = TRUE
      WHERE sp.student_id = ? AND t.subject = ?
      ORDER BY sp.updated_at DESC, sp.id DESC
      LIMIT 1`,
    [q.studentId, q.subject]
  );
  if (!pos) {
    const [[anyTrack]] = await conn.query<any[]>(`SELECT id FROM tracks WHERE subject = ? AND active = TRUE LIMIT 1`, [
      q.subject,
    ]);
    choice.reason = anyTrack ? 'no_position' : 'no_track';
    choice.relaxations.push(`curriculum:${choice.reason}`);
    // An alert, not a warning: this student is being served nothing at all, and
    // the fix is operational (backfill the position). Never fall back to legacy.
    logger.error(
      { studentId: q.studentId, subject: q.subject, reason: choice.reason, alert: 'missing_curriculum_position' },
      'curriculum selection: student has no curriculum position — serving nothing'
    );
    return choice;
  }
  choice.trackId = Number(pos.track_id);
  choice.positionHourId = Number(pos.hour_id);

  const trackId = choice.trackId;
  const filters = hardFilters(q);

  /** Unseen candidates from a pool, ranked. `excludeCurrentHour` drives the revision mix. */
  async function unseen(poolIds: number[], f: { sql: string; params: any[] }, excludeCurrentHour = false) {
    const [rows] = await conn.query<any[]>(
      `SELECT m.id AS mission_id, m.version AS mission_version, m.difficulty, m.hour_id,
              c.code AS credit_code, h.hour_number,
              (m.hour_id = sp.hour_id) AS is_current_hour,
              (SELECT COUNT(*) FROM mission_tags mt
                 JOIN student_interests si ON si.tag = mt.tag AND si.student_id = ?
                WHERE mt.mission_id = m.id) AS overlap
       ${CURRICULUM_JOINS}
       WHERE m.hour_id IN (?)
         AND sp.track_id = ?
         AND ${CEILING}
         ${excludeCurrentHour ? 'AND m.hour_id <> sp.hour_id' : ''}
         ${f.sql}
         AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)
       ORDER BY is_current_hour DESC, c.sequence DESC, h.hour_number DESC,
                ABS(CAST(m.difficulty AS SIGNED) - ?) ASC, overlap DESC, RAND()
       LIMIT 10`,
      [q.studentId, q.studentId, poolIds, trackId, ...f.params, q.studentId, q.targetLevel]
    );
    return rows;
  }

  // REVISION_MIX_PERCENT: sometimes revise an earlier hour even though the
  // current one still has unseen missions (spaced repetition). Rolled once per
  // selection; falls through to the normal ranking when nothing earlier qualifies.
  const mix = revisionMixPercent();
  const mixRoll = mix > 0 && Math.random() * 100 < mix;

  const tiers: PoolTier[] = poolLookbackHours() > 0 ? ['current', 'credit', 'track'] : ['current', 'track'];

  for (const tier of tiers) {
    if (tier === 'credit') {
      choice.relaxations.push('curriculum:widen_credit');
      logger.info({ studentId: q.studentId, relax: 'a' }, 'curriculum selection: widen to all hours in the credit');
    } else if (tier === 'track') {
      choice.relaxations.push('curriculum:previous_credits');
      logger.info({ studentId: q.studentId, relax: 'b' }, 'curriculum selection: widen to previous credits');
    }

    const poolIds = opts.poolOverride ?? (await getHourPool(q.studentId, trackId, { tier, conn }));
    choice.poolSizes[tier] = poolIds.length;
    if (poolIds.length === 0) continue;

    if (mixRoll && tier === 'current') {
      const revisionRows = await unseen(poolIds, filters, true);
      if (revisionRows.length > 0) {
        choice.candidates = revisionRows.map((r) => toCandidate(r));
        choice.chosen = choice.candidates[0];
        choice.tier = tier;
        choice.revisionMix = true;
        logger.info(
          { studentId: q.studentId, mixPercent: mix, hourId: choice.chosen.hour_id },
          'curriculum selection: revision mix — drawing from an earlier hour'
        );
        return choice;
      }
    }

    const rows = await unseen(poolIds, filters);
    if (rows.length > 0) {
      choice.candidates = rows.map((r) => toCandidate(r));
      choice.chosen = choice.candidates[0];
      choice.tier = tier;
      return choice;
    }
  }

  // b2. Widen the time band upward before resorting to a repeat: an empty slot is
  // worse for the student than a slightly longer mission on the right content.
  if (q.timeBands && q.timeBands.length > 0) {
    const widened = widenTimeBands(q.timeBands);
    if (widened.length > q.timeBands.length) {
      choice.relaxations.push('curriculum:widen_time_band');
      logger.info(
        { studentId: q.studentId, relax: 'b2', from: q.timeBands, to: widened },
        'curriculum selection: widen time band'
      );
      const bandPool = opts.poolOverride ?? (await getHourPool(q.studentId, trackId, { tier: 'track', conn }));
      choice.poolSizes.widen_band = bandPool.length;
      if (bandPool.length > 0) {
        const rows = await unseen(bandPool, hardFilters({ ...q, timeBands: widened }));
        if (rows.length > 0) {
          choice.candidates = rows.map((r) => toCandidate(r));
          choice.chosen = choice.candidates[0];
          choice.tier = 'widen_band';
          return choice;
        }
      }
    }
  }

  // c. Repeat the completed mission seen longest ago, within the completed
  // curriculum. Once the band has been widened, the repeat honours the widened
  // band too — otherwise we could return empty while an eligible mission exists.
  choice.relaxations.push('curriculum:repeat_oldest');
  logger.info({ studentId: q.studentId, relax: 'c' }, 'curriculum selection: repeat oldest completed mission');
  const repeatFilters =
    choice.relaxations.includes('curriculum:widen_time_band') && q.timeBands
      ? hardFilters({ ...q, timeBands: widenTimeBands(q.timeBands) })
      : filters;
  const trackPool = opts.poolOverride ?? (await getHourPool(q.studentId, choice.trackId, { tier: 'track', conn }));
  choice.poolSizes.repeat_oldest = trackPool.length;
  if (trackPool.length > 0) {
    const [rows] = await conn.query<any[]>(
      `SELECT m.id AS mission_id, m.version AS mission_version, m.difficulty, m.hour_id,
              c.code AS credit_code, h.hour_number,
              (m.hour_id = sp.hour_id) AS is_current_hour,
              0 AS overlap,
              (SELECT MAX(a.assigned_at) FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id) AS last_seen,
              -- assigned_at has ONE-SECOND resolution, so several assignments can
              -- share a timestamp (a demo, or a fast student). Assignment ids are
              -- monotonic, so the newest assignment's id orders those ties in the
              -- order they really happened; without it the ordering fell through
              -- to m.id and served the same mission again and again.
              (SELECT MAX(a.id) FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id) AS last_seen_seq,
              (SELECT MAX(a.revision_seq) FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id) AS max_rev
       ${CURRICULUM_JOINS}
       WHERE m.hour_id IN (?)
         AND sp.track_id = ?
         AND ${CEILING}
         ${repeatFilters.sql}
         AND EXISTS (SELECT 1 FROM assignments a WHERE a.student_id = ? AND a.mission_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM assignments a
                          WHERE a.student_id = ? AND a.mission_id = m.id AND a.status <> 'graded')
       ORDER BY last_seen ASC, last_seen_seq ASC, m.id ASC
       LIMIT 10`,
      [
        q.studentId,
        q.studentId,
        q.studentId,
        q.studentId,
        trackPool,
        choice.trackId,
        ...repeatFilters.params,
        q.studentId,
        q.studentId,
      ]
    );
    if (rows.length > 0) {
      choice.candidates = rows.map((r) => toCandidate(r, Number(r.max_rev) + 1));
      choice.chosen = choice.candidates[0];
      choice.tier = 'repeat_oldest';
      choice.revision = true;
      return choice;
    }
  }

  // d. Nothing eligible anywhere in the completed curriculum.
  choice.relaxations.push('curriculum:exhausted');
  choice.reason = 'exhausted';
  logger.warn(
    { studentId: q.studentId, trackId: choice.trackId, poolSizes: choice.poolSizes },
    'curriculum selection: no eligible mission in the completed curriculum'
  );
  return choice;
}

/** Write the selection_log row for a curriculum choice (chosen or gap). */
export async function logCurriculumSelection(
  conn: Pick<PoolConnection, 'query'>,
  studentId: number,
  choice: CurriculumChoice,
  extraFilters: Record<string, unknown> = {}
): Promise<void> {
  const tierSize = choice.tier ? choice.poolSizes[choice.tier] : undefined;
  const poolSize = tierSize ?? choice.poolSizes.current ?? null;
  await conn.query(
    `INSERT INTO selection_log (student_id, chosen_mission, candidates, filters_applied, pool_size, chosen_hour_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      studentId,
      choice.chosen?.mission_id ?? null,
      JSON.stringify(choice.candidates),
      JSON.stringify({
        mode: 'curriculum',
        track_id: choice.trackId,
        position_hour_id: choice.positionHourId,
        tier: choice.tier,
        revision: choice.revision,
        revision_mix: choice.revisionMix,
        relaxations: choice.relaxations,
        pool_sizes: choice.poolSizes,
        reason: choice.reason,
        lookback_hours: poolLookbackHours(),
        ...extraFilters,
      }),
      poolSize,
      choice.chosen?.hour_id ?? null,
    ]
  );
}

/** Free-play selection in curriculum mode (no slot filters). */
async function selectMissionCurriculum(studentId: number): Promise<SelectionResult | null> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the student so concurrent selections cannot both pick the same mission.
    const [[student]] = await conn.query<any[]>(
      `SELECT id, age, subject, current_level FROM students WHERE id = ? FOR UPDATE`,
      [studentId]
    );
    if (!student) throw new Error(`Student ${studentId} not found`);

    const choice = await chooseCurriculumMission(conn, {
      studentId,
      subject: student.subject,
      age: Number(student.age),
      targetLevel: Number(student.current_level),
    });
    if (!choice.chosen) {
      await logCurriculumSelection(conn, studentId, choice);
      await conn.commit();
      return null;
    }
    const top = choice.chosen;
    const [ins] = await conn.query<any>(
      `INSERT INTO assignments
         (student_id, mission_id, mission_version, level_at_assign, status, revision_seq, is_revision)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      [studentId, top.mission_id, top.mission_version, Number(student.current_level), top.revision_seq, choice.revision]
    );
    await logCurriculumSelection(conn, studentId, choice);
    await conn.commit();
    return { assignmentId: Number(ins.insertId), missionId: top.mission_id };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ===========================================================================
// Legacy selection (SELECTION_MODE=legacy) — unchanged
// ===========================================================================

interface Candidate {
  mission_id: number;
  mission_version: number;
  difficulty: number;
  overlap: number;
}

/**
 * Selects the next mission for a student using pure SQL (no AI, no randomness
 * except RAND() tie-breaking).
 *
 * HARD FILTERS (mission excluded if any fail):
 *   - status = 'live'
 *   - subject matches student's subject
 *   - difficulty = student's current_level exactly
 *   - student's age BETWEEN age_min AND age_max
 *   - NOT already assigned to this student (enforced also by UNIQUE KEY)
 *
 * RANK survivors by count of overlapping tags (mission_tags vs
 * student_interests) descending, tie-break RAND(), LIMIT 10.
 *
 * Returns null if there are no candidates.
 */
export async function selectMission(studentId: number): Promise<SelectionResult | null> {
  if (selectionMode() === 'curriculum') return selectMissionCurriculum(studentId);
  const conn = await pool.getConnection();
  try {
    // Read the student.
    const [studentRows] = await conn.query<any[]>(
      `SELECT id, age, subject, current_level
         FROM students
        WHERE id = ?`,
      [studentId]
    );
    if (studentRows.length === 0) {
      throw new Error(`Student ${studentId} not found`);
    }
    const student = studentRows[0];

    const filters = {
      status: 'live',
      subject: student.subject,
      difficulty: student.current_level,
      age: student.age,
      not_already_assigned: true,
    };

    // Candidate query — rank by tag overlap, tie-break RAND(), LIMIT 10.
    const [candidates] = await conn.query<any[]>(
      `SELECT m.id AS mission_id,
              m.version AS mission_version,
              m.difficulty AS difficulty,
              COUNT(si.tag) AS overlap
         FROM missions m
         LEFT JOIN mission_tags mt ON mt.mission_id = m.id
         LEFT JOIN student_interests si
                ON si.student_id = ? AND si.tag = mt.tag
        WHERE m.status = 'live'
          AND m.subject = ?
          AND m.difficulty = ?
          AND ? BETWEEN m.age_min AND m.age_max
          AND NOT EXISTS (
                SELECT 1 FROM assignments a
                 WHERE a.student_id = ? AND a.mission_id = m.id
              )
        GROUP BY m.id, m.version, m.difficulty
        ORDER BY overlap DESC, RAND()
        LIMIT 10`,
      [studentId, student.subject, student.current_level, student.age, studentId]
    );

    const candidateList: Candidate[] = candidates.map((c) => ({
      mission_id: Number(c.mission_id),
      mission_version: Number(c.mission_version),
      difficulty: Number(c.difficulty),
      overlap: Number(c.overlap),
    }));

    if (candidateList.length === 0) {
      // Log the empty selection so the audit trail is complete.
      await conn.query(
        `INSERT INTO selection_log
           (student_id, chosen_mission, candidates, filters_applied)
         VALUES (?, NULL, ?, ?)`,
        [studentId, JSON.stringify([]), JSON.stringify(filters)]
      );
      return null;
    }

    const top = candidateList[0];

    // 1. Create the assignment (mission_version copied from the mission).
    const [ins] = await conn.query<any>(
      `INSERT INTO assignments
         (student_id, mission_id, mission_version, level_at_assign, status)
       VALUES (?, ?, ?, ?, 'open')`,
      [studentId, top.mission_id, top.mission_version, student.current_level]
    );
    const assignmentId = ins.insertId as number;

    // 2. Log the full candidate array with scores and the filters used.
    await conn.query(
      `INSERT INTO selection_log
         (student_id, chosen_mission, candidates, filters_applied)
       VALUES (?, ?, ?, ?)`,
      [studentId, top.mission_id, JSON.stringify(candidateList), JSON.stringify(filters)]
    );

    return { assignmentId, missionId: top.mission_id };
  } finally {
    conn.release();
  }
}
