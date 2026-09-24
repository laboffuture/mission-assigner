import { pool } from './db.js';
import { applyProgression } from './progression.js';
import { logAttempt } from './tracking.js';
import { withDbRetry } from './retry.js';
import { takeTransientFault } from './testFaults.js';

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 4;

export type ScoreBand = 'pass_strong' | 'pass' | 'fail';

export interface GradeResult {
  correct: boolean;
  band: ScoreBand;
  correctAnswer: string;
  /** The explanation from the mission's answer_key — shown to the student after
   *  grading (right or wrong) because the platform builds ability, not measures
   *  it. Empty string when the mission has no explanation. */
  correctExplanation: string;
  fromLevel: number;
  toLevel: number;
  reason: string;
  // Stage 3 additions (ignored by the Stage 1 UI/tests, additive):
  studentId: number;
  assignmentId: number;
  difficulty: number;
  stallCount: number;
  assistanceRaised: boolean;
  /** Curriculum revision repeat: earns attempt/submit XP but never 'correct'. */
  isRevision: boolean;
  timeToSubmitSeconds: number | null;
}

/**
 * A submission refused for a reason that is the CLIENT's (the assignment is not
 * open, the answer is not one of the mission's options). The route answers 400
 * with `code` and logs it at WARN — it is expected, not an incident.
 */
export class SubmitRejection extends Error {
  constructor(
    readonly code: 'bad_request' | 'invalid_answer',
    message: string
  ) {
    super(message);
    this.name = 'SubmitRejection';
  }
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
function parseAnswerKey(raw: unknown): { correct: string; explanation: string } {
  const shape = (o: any) => ({ correct: String(o?.correct ?? ''), explanation: String(o?.explanation ?? '') });
  if (raw == null) return { correct: '', explanation: '' };
  if (typeof raw === 'string') {
    try {
      return shape(JSON.parse(raw));
    } catch {
      return { correct: '', explanation: '' };
    }
  }
  return shape(raw);
}

/**
 * Grades an open assignment and applies progression (the no-demotion ladder,
 * from progression.ts) in ONE transaction. Level logic lives in progression.ts;
 * this function owns grading and the transaction boundary.
 *
 * A deadlock or a lock-wait timeout here rolled the whole transaction back and
 * reached the student as a failed submit they had to repeat by hand. Because the
 * transaction boundary is this function, running it again is exactly as safe as
 * the student pressing submit again — so withDbRetry does it for them. Only
 * transient failures are retried; a rejection (not open, not an option) is the
 * answer, not a blip. See src/retry.ts.
 */
export async function submitAndGrade(assignmentId: number, selected: string): Promise<GradeResult> {
  return withDbRetry('submitAndGrade', () => submitAndGradeOnce(assignmentId, selected));
}

async function submitAndGradeOnce(assignmentId: number, selected: string): Promise<GradeResult> {
  // Test-only, and only when something armed it: fail this attempt the way a
  // busy database fails, so the retry can be tested without racing two real
  // transactions. See src/testFaults.ts.
  const injected = takeTransientFault();
  if (injected) throw injected;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Load assignment joined to mission + student.
    const [rows] = await conn.query<any[]>(
      `SELECT a.id            AS assignment_id,
              a.status        AS status,
              a.is_revision   AS is_revision,
              a.student_id    AS student_id,
              a.opened_at     AS opened_at,
              a.assigned_at   AS assigned_at,
              a.mission_id    AS mission_id,
              m.answer_key    AS answer_key,
              m.difficulty    AS difficulty
         FROM assignments a
         JOIN missions m ON m.id = a.mission_id
        WHERE a.id = ?
        FOR UPDATE`,
      [assignmentId]
    );

    if (rows.length === 0) {
      throw new SubmitRejection('bad_request', `Assignment ${assignmentId} not found`);
    }
    const row = rows[0];
    if (row.status !== 'open') {
      throw new SubmitRejection('bad_request', `Assignment ${assignmentId} is not open (status=${row.status})`);
    }

    // The answer must be one of THIS mission's option keys — exactly. Compared
    // in JS, not SQL: option_key is compared case- and accent-insensitively by
    // the column collation, so `WHERE option_key = 'A'` would accept 'A' for 'a'
    // (and grade it wrong). Anything else used to be stored as the response.
    const [opts] = await conn.query<any[]>(`SELECT option_key FROM mission_options WHERE mission_id = ?`, [
      row.mission_id,
    ]);
    if (!opts.some((o) => o.option_key === selected)) {
      throw new SubmitRejection(
        'invalid_answer',
        `selected must be one of this mission's options (${opts.map((o) => o.option_key).join(', ')})`
      );
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
      correctExplanation: answerKey.explanation,
      fromLevel: prog.fromLevel,
      toLevel: prog.toLevel,
      reason: prog.reason,
      studentId,
      assignmentId,
      difficulty,
      stallCount: prog.stallCount,
      assistanceRaised: prog.assistanceRaised,
      isRevision: Boolean(Number(row.is_revision)),
      timeToSubmitSeconds,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
