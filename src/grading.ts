import { pool } from './db.js';

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 4;

export type ScoreBand = 'pass_strong' | 'pass' | 'fail';

export interface GradeResult {
  correct: boolean;
  band: ScoreBand;
  correctAnswer: string;
  fromLevel: number;
  toLevel: number;
  reason: string;
}

/** Maps a percentage to a score band. */
export function toBand(pct: number): ScoreBand {
  if (pct >= 85) return 'pass_strong';
  if (pct >= 50) return 'pass';
  return 'fail';
}

export interface NextLevel {
  level: number;
  wrong: number;
  reason: string;
}

/**
 * The learning ladder (never demotes — this is a learning platform, not a test):
 *   - pass (band !== 'fail'): level up (capped), reset wrong, 'pass_level_up'
 *   - fail: hold the SAME level and serve another question there;
 *           increment the wrong counter for the audit trail, 'wrong_retry_same_level'
 * Level never decreases.
 */
export function nextLevel(
  band: ScoreBand,
  level: number,
  consecutiveWrong: number
): NextLevel {
  if (band !== 'fail') {
    return {
      level: Math.min(level + 1, MAX_LEVEL),
      wrong: 0,
      reason: 'pass_level_up',
    };
  }
  return {
    level,
    wrong: consecutiveWrong + 1,
    reason: 'wrong_retry_same_level',
  };
}

/**
 * mysql2 returns JSON columns as a parsed object on some versions and as a raw
 * string on others. Normalise defensively.
 */
function parseAnswerKey(raw: unknown): { correct: string } {
  if (raw == null) return { correct: '' };
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { correct: '' };
    }
  }
  return raw as { correct: string };
}

/**
 * Grades an open assignment and applies the adaptive ladder in one transaction.
 */
export async function submitAndGrade(
  assignmentId: number,
  selected: string
): Promise<GradeResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Load assignment joined to mission + student.
    const [rows] = await conn.query<any[]>(
      `SELECT a.id            AS assignment_id,
              a.status        AS status,
              a.student_id    AS student_id,
              m.answer_key    AS answer_key,
              s.current_level AS current_level,
              s.consecutive_wrong AS consecutive_wrong
         FROM assignments a
         JOIN missions m ON m.id = a.mission_id
         JOIN students s ON s.id = a.student_id
        WHERE a.id = ?
        FOR UPDATE`,
      [assignmentId]
    );

    if (rows.length === 0) {
      throw new Error(`Assignment ${assignmentId} not found`);
    }
    const row = rows[0];
    if (row.status !== 'open') {
      throw new Error(`Assignment ${assignmentId} is not open (status=${row.status})`);
    }

    // 2. Read level/wrong BEFORE updating.
    const fromLevel = Number(row.current_level);
    const consecutiveWrong = Number(row.consecutive_wrong);

    // 3. Parse answer_key (string or object).
    const answerKey = parseAnswerKey(row.answer_key);

    // 4. Grade.
    const correct = selected === answerKey.correct;
    const pct = correct ? 100 : 0;
    const band = toBand(pct);

    // 5. Update the assignment.
    await conn.query(
      `UPDATE assignments
          SET status = 'graded',
              response = ?,
              score_pct = ?,
              score_band = ?,
              submitted_at = NOW(),
              graded_at = NOW()
        WHERE id = ?`,
      [JSON.stringify({ selected }), pct, band, assignmentId]
    );

    // 6. Compute + apply the ladder.
    const next = nextLevel(band, fromLevel, consecutiveWrong);
    await conn.query(
      `UPDATE students
          SET current_level = ?, consecutive_wrong = ?
        WHERE id = ?`,
      [next.level, next.wrong, row.student_id]
    );

    // 7. Record the level event.
    await conn.query(
      `INSERT INTO level_events
         (student_id, assignment_id, from_level, to_level, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [row.student_id, assignmentId, fromLevel, next.level, next.reason]
    );

    await conn.commit();

    // 8. Return the result.
    return {
      correct,
      band,
      correctAnswer: answerKey.correct,
      fromLevel,
      toLevel: next.level,
      reason: next.reason,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
