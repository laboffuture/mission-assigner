import { pool } from './db.js';
import { applyProgression } from './progression.js';
import { logAttempt } from './tracking.js';

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
  // Stage 3 additions (ignored by the Stage 1 UI/tests, additive):
  studentId: number;
  assignmentId: number;
  difficulty: number;
  stallCount: number;
  assistanceRaised: boolean;
  timeToSubmitSeconds: number | null;
}

/** Maps a percentage to a score band. */
export function toBand(pct: number): ScoreBand {
  if (pct >= 85) return 'pass_strong';
  if (pct >= 50) return 'pass';
  return 'fail';
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
 * Grades an open assignment and applies progression (the no-demotion ladder,
 * from progression.ts) in ONE transaction. Level logic lives in progression.ts;
 * this function owns grading and the transaction boundary.
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
              a.opened_at     AS opened_at,
              a.assigned_at   AS assigned_at,
              m.answer_key    AS answer_key,
              m.difficulty    AS difficulty
         FROM assignments a
         JOIN missions m ON m.id = a.mission_id
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

    const studentId = Number(row.student_id);
    const difficulty = Number(row.difficulty);

    // 2. Parse answer_key (string or object) and grade.
    const answerKey = parseAnswerKey(row.answer_key);
    const correct = selected === answerKey.correct;
    const pct = correct ? 100 : 0;
    const band = toBand(pct);

    // time_to_submit_seconds: from when the student opened the mission (or, if
    // it was never explicitly opened, from when it was assigned) to now. Computed
    // in SQL (TIMESTAMPDIFF) so it stays in the DB's own timezone — computing it
    // in JS against a driver-returned Date skews it by the local UTC offset.
    // Stored for later difficulty calibration (see the mission-quality report).
    const [[tt]] = await conn.query<any[]>(
      `SELECT TIMESTAMPDIFF(SECOND, COALESCE(opened_at, assigned_at), NOW()) AS secs
         FROM assignments WHERE id = ?`,
      [assignmentId]
    );
    const timeToSubmitSeconds = Math.max(0, Number(tt.secs ?? 0));

    // 3. Mark the assignment graded (before progression, so placement can count
    //    it as a completed mission).
    await conn.query(
      `UPDATE assignments
          SET status = 'graded',
              response = ?,
              score_pct = ?,
              score_band = ?,
              submitted_at = NOW(),
              graded_at = NOW(),
              time_to_submit_seconds = ?
        WHERE id = ?`,
      [JSON.stringify({ selected }), pct, band, timeToSubmitSeconds, assignmentId]
    );

    // Audit trail: the submission and the grade (atomic with the grade itself).
    await logAttempt(assignmentId, studentId, 'submitted', { selected }, conn);
    await logAttempt(assignmentId, studentId, 'graded', { correct, band }, conn);

    // 4. Apply the ladder + assistance (same transaction).
    const prog = await applyProgression(conn, studentId, assignmentId, correct);

    await conn.commit();

    return {
      correct,
      band,
      correctAnswer: answerKey.correct,
      fromLevel: prog.fromLevel,
      toLevel: prog.toLevel,
      reason: prog.reason,
      studentId,
      assignmentId,
      difficulty,
      stallCount: prog.stallCount,
      assistanceRaised: prog.assistanceRaised,
      timeToSubmitSeconds,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
