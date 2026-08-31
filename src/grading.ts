import { pool } from './db.js';
import { applyProgression } from './progression.js';

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

    // 3. Mark the assignment graded (before progression, so placement can count
    //    it as a completed mission).
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
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
