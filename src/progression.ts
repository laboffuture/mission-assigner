import type { PoolConnection } from 'mysql2/promise';
import { PLACEMENT_MISSION_LIMIT } from './coldstart.js';
import { logger } from './logger.js';

export const DEFAULT_MAX_LEVEL = 4;
export const DEFAULT_MIN_LEVEL = 0;
export const STALL_THRESHOLD = 3;

export interface ProgressionResult {
  fromLevel: number;
  toLevel: number;
  reason: string;
  stallCount: number;
  assistanceRaised: boolean;
  placementActive: boolean;
}

/**
 * applyProgression — the level engine. Runs INSIDE the grading transaction
 * (same connection) so the level change, the level_events row and any
 * assistance_events row all commit atomically with the grade.
 *
 * SAFETY: level NEVER decreases. There is no demotion path anywhere here.
 *   - Correct: level = min(level + 1, segment.max_level). stall_count = 0.
 *              reason 'pass_level_up'.
 *   - Wrong:   level UNCHANGED. stall_count += 1. reason 'wrong_retry_same_level'.
 *
 * Assistance: when stall_count reaches STALL_THRESHOLD (3) on a wrong answer,
 * raise exactly one assistance_events row (with the last 3 failures as context)
 * and reset stall_count to 0 so the next wrong answer does not raise another.
 * Assistance NEVER blocks the student's next mission.
 *
 * Placement (only when placement_status = 'in_progress', i.e. COLD_START_STRATEGY
 * = PLACEMENT): a fast ladder — a correct answer moves up immediately; a wrong
 * answer ends placement at the current level; placement also ends after
 * PLACEMENT_MISSION_LIMIT graded missions. Level still never decreases.
 */
export async function applyProgression(
  conn: PoolConnection,
  studentId: number,
  assignmentId: number,
  correct: boolean
): Promise<ProgressionResult> {
  const [rows] = await conn.query<any[]>(
    `SELECT s.current_level, s.stall_count, s.placement_status,
            COALESCE(seg.max_level, ?) AS max_level,
            COALESCE(seg.min_level, ?) AS min_level
       FROM students s
       LEFT JOIN segments seg ON seg.id = s.segment_id
      WHERE s.id = ?
      FOR UPDATE`,
    [DEFAULT_MAX_LEVEL, DEFAULT_MIN_LEVEL, studentId]
  );
  if (rows.length === 0) throw new Error(`Student ${studentId} not found`);

  const fromLevel = Number(rows[0].current_level);
  const priorStall = Number(rows[0].stall_count);
  const maxLevel = Number(rows[0].max_level);
  const placementActive = rows[0].placement_status === 'in_progress';

  if (placementActive) {
    return applyPlacement(conn, studentId, assignmentId, correct, fromLevel, maxLevel);
  }

  let toLevel = fromLevel;
  let stallCount = priorStall;
  let reason: string;

  if (correct) {
    toLevel = Math.min(fromLevel + 1, maxLevel); // capped; never above segment max
    stallCount = 0;
    reason = 'pass_level_up';
  } else {
    toLevel = fromLevel; // NEVER decreases
    stallCount = priorStall + 1;
    reason = 'wrong_retry_same_level';
  }

  // Assistance trigger (before we persist, so we can reset the counter in the
  // same write). Raising it never blocks progress.
  let assistanceRaised = false;
  let stallToPersist = stallCount;
  if (!correct && stallCount >= STALL_THRESHOLD) {
    await raiseAssistance(conn, studentId, fromLevel);
    assistanceRaised = true;
    stallToPersist = 0; // reset so the next wrong answer doesn't raise again
  }

  // consecutive_wrong is kept in lock-step with stall_count for the Stage 1 view.
  await conn.query(`UPDATE students SET current_level = ?, stall_count = ?, consecutive_wrong = ? WHERE id = ?`, [
    toLevel,
    stallToPersist,
    stallToPersist,
    studentId,
  ]);

  await conn.query(
    `INSERT INTO level_events (student_id, assignment_id, from_level, to_level, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [studentId, assignmentId, fromLevel, toLevel, reason]
  );

  return { fromLevel, toLevel, reason, stallCount: stallToPersist, assistanceRaised, placementActive: false };
}

async function applyPlacement(
  conn: PoolConnection,
  studentId: number,
  assignmentId: number,
  correct: boolean,
  fromLevel: number,
  maxLevel: number
): Promise<ProgressionResult> {
  // Count graded missions so far (the current one is already 'graded').
  const [[{ graded }]] = await conn.query<any[]>(
    `SELECT COUNT(*) AS graded FROM assignments WHERE student_id = ? AND status = 'graded'`,
    [studentId]
  );
  const gradedCount = Number(graded);

  let toLevel = fromLevel;
  let reason: string;
  let placementDone: boolean;

  if (correct) {
    toLevel = Math.min(fromLevel + 1, maxLevel);
    reason = 'placement_pass_level_up';
    placementDone = gradedCount >= PLACEMENT_MISSION_LIMIT; // ends after the limit
  } else {
    toLevel = fromLevel; // never decreases; placement just ends here
    reason = 'placement_end_wrong';
    placementDone = true; // first wrong answer ends placement
  }

  await conn.query(
    `UPDATE students
        SET current_level = ?, stall_count = 0, consecutive_wrong = 0,
            placement_status = ?
      WHERE id = ?`,
    [toLevel, placementDone ? 'complete' : 'in_progress', studentId]
  );

  await conn.query(
    `INSERT INTO level_events (student_id, assignment_id, from_level, to_level, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [studentId, assignmentId, fromLevel, toLevel, reason]
  );

  return { fromLevel, toLevel, reason, stallCount: 0, assistanceRaised: false, placementActive: !placementDone };
}

/** Build the assistance context from the student's last 3 failed assignments. */
async function raiseAssistance(conn: PoolConnection, studentId: number, levelAtTrigger: number): Promise<void> {
  const [failed] = await conn.query<any[]>(
    `SELECT a.id AS assignment_id, a.mission_id, a.response,
            GROUP_CONCAT(mt.tag) AS tags
       FROM assignments a
       LEFT JOIN mission_tags mt ON mt.mission_id = a.mission_id
      WHERE a.student_id = ? AND a.score_band = 'fail'
      GROUP BY a.id, a.mission_id, a.response
      ORDER BY a.graded_at DESC, a.id DESC
      LIMIT 3`,
    [studentId]
  );

  const failures = failed.map((r: any) => {
    let selected: string | null = null;
    let resp = r.response;
    if (typeof resp === 'string') {
      try {
        resp = JSON.parse(resp);
      } catch {
        resp = null;
      }
    }
    if (resp && typeof resp === 'object') selected = (resp as any).selected ?? null;
    const tags = r.tags ? String(r.tags).split(',') : [];
    return { assignment_id: Number(r.assignment_id), mission_id: Number(r.mission_id), selected, tags };
  });

  const tagsInvolved = Array.from(new Set(failures.flatMap((f: any) => f.tags)));
  const context = { failed_assignments: failures, tags_involved: tagsInvolved };

  await conn.query(
    `INSERT INTO assistance_events (student_id, trigger_reason, level_at_trigger, context, status)
     VALUES (?, 'stall_threshold', ?, ?, 'open')`,
    [studentId, levelAtTrigger, JSON.stringify(context)]
  );

  logger.info({ studentId, levelAtTrigger, tags: tagsInvolved }, 'assistance raised');
}
