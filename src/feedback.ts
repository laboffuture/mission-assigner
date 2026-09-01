import { pool } from './db.js';
import { awardXp, type XpAward } from './xp.js';
import { logAttempt } from './tracking.js';

export type AnswerType = 'scale_1_5' | 'yes_no' | 'single_select' | 'free_text';

export interface FeedbackQuestion {
  id: number;
  question_key: string;
  prompt: string;
  answer_type: AnswerType;
  options: string[] | null;
  display_order: number;
  required: boolean;
}

export interface SubmittedAnswer {
  question_key: string;
  value: string;
}

export interface FeedbackResult {
  alreadyComplete: boolean;
  responsesSaved: number;
  xp: XpAward;
}

/** An error carrying an HTTP status, so the API can map it to the right code. */
export class FeedbackError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// getQuestions — active questions, ordered. Cached for the process lifetime;
// SME edits are rare and a restart picks them up. Retired (active=FALSE)
// questions are never returned, but historical responses that reference them
// remain readable via the denormalised question_key.
// ---------------------------------------------------------------------------
let cache: FeedbackQuestion[] | null = null;

export async function getQuestions(): Promise<FeedbackQuestion[]> {
  if (cache) return cache;
  const [rows] = await pool.query<any[]>(
    `SELECT id, question_key, prompt, answer_type, options, display_order, required
       FROM feedback_questions
      WHERE active = TRUE
      ORDER BY display_order ASC`
  );
  cache = rows.map((r) => ({
    id: Number(r.id),
    question_key: r.question_key,
    prompt: r.prompt,
    answer_type: r.answer_type,
    options: parseOptions(r.options),
    display_order: Number(r.display_order),
    required: Boolean(r.required),
  }));
  return cache;
}

/** Test/ops hook — drop the cache so the next getQuestions() re-reads the DB. */
export function clearQuestionCache(): void {
  cache = null;
}

function parseOptions(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate a single answer against its question's type. Returns the normalised
 * value to store, or throws FeedbackError(400) if invalid. NOTHING is saved on
 * any failure (the caller runs this before any INSERT).
 */
function validateAnswer(q: FeedbackQuestion, rawValue: string): string {
  const value = String(rawValue ?? '');
  switch (q.answer_type) {
    case 'scale_1_5': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new FeedbackError(400, `"${q.question_key}" expects an integer 1–5, got "${value}"`);
      }
      return String(n);
    }
    case 'yes_no': {
      const v = value.trim().toLowerCase();
      if (v !== 'yes' && v !== 'no') {
        throw new FeedbackError(400, `"${q.question_key}" expects yes/no, got "${value}"`);
      }
      return v;
    }
    case 'single_select': {
      const opts = q.options ?? [];
      if (!opts.includes(value)) {
        throw new FeedbackError(400, `"${q.question_key}" must be one of ${JSON.stringify(opts)}, got "${value}"`);
      }
      return value;
    }
    case 'free_text': {
      const t = value.trim();
      if (t.length > 500) {
        throw new FeedbackError(400, `"${q.question_key}" exceeds 500 characters`);
      }
      return t;
    }
  }
}

/**
 * submitFeedback — capture a student's answers after a graded mission.
 *
 * 1. Verify the assignment belongs to `studentId` and is 'graded'. Feedback
 *    comes AFTER the result, never before.
 * 2. Verify every required question has an answer; reject the WHOLE submission
 *    if any is missing — partial feedback is never saved.
 * 3. Validate each answer against its type.
 * 4. Insert all responses in ONE transaction.
 * 5. Mark the assignment feedback_status='complete'.
 * 6. Award 'feedback' XP once (guarded against double-award).
 * 7. Write an attempt_logs 'feedback_submitted' row.
 */
export async function submitFeedback(
  assignmentId: number,
  studentId: number,
  answers: SubmittedAnswer[]
): Promise<FeedbackResult> {
  const questions = await getQuestions();
  const byKey = new Map(questions.map((q) => [q.question_key, q]));

  // Map provided answers by key (last write wins), ignoring blank/absent.
  const provided = new Map<string, string>();
  for (const a of answers ?? []) {
    if (a && typeof a.question_key === 'string') provided.set(a.question_key, String(a.value ?? ''));
  }

  // Reject unknown keys outright — the client is out of sync with the config.
  for (const key of provided.keys()) {
    if (!byKey.has(key)) throw new FeedbackError(400, `unknown question_key "${key}"`);
  }

  // Required questions must all be present and non-empty.
  for (const q of questions) {
    if (q.required) {
      const v = provided.get(q.question_key);
      if (v == null || v.trim() === '') {
        throw new FeedbackError(400, `missing required answer for "${q.question_key}"`);
      }
    }
  }

  // Validate + normalise everything BEFORE opening the transaction, so a bad
  // answer can never leave a partial write behind.
  const toInsert: Array<{ q: FeedbackQuestion; value: string }> = [];
  for (const q of questions) {
    const raw = provided.get(q.question_key);
    if (raw == null || (q.answer_type === 'free_text' && raw.trim() === '' && !q.required)) continue;
    toInsert.push({ q, value: validateAnswer(q, raw) });
  }

  const conn = await pool.getConnection();
  let alreadyComplete = false;
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query<any[]>(
      `SELECT student_id, status, feedback_status
         FROM assignments WHERE id = ? FOR UPDATE`,
      [assignmentId]
    );
    if (rows.length === 0) throw new FeedbackError(404, `assignment ${assignmentId} not found`);
    const asg = rows[0];

    if (Number(asg.student_id) !== Number(studentId)) {
      throw new FeedbackError(403, 'cannot submit feedback for another student');
    }
    if (asg.status !== 'graded') {
      throw new FeedbackError(409, 'feedback can only be submitted after the mission is graded');
    }

    // Idempotency (AC6): already complete -> no new rows, no XP.
    if (asg.feedback_status === 'complete') {
      alreadyComplete = true;
      await conn.commit();
      const [[t]] = await conn.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [studentId]);
      return {
        alreadyComplete: true,
        responsesSaved: 0,
        xp: { awarded: false, points: 0, reason: 'already_awarded', totalXp: t ? Number(t.total_xp) : 0 },
      };
    }

    for (const item of toInsert) {
      await conn.query(
        `INSERT INTO feedback_responses
           (assignment_id, student_id, question_id, question_key, answer_value)
         VALUES (?, ?, ?, ?, ?)`,
        [assignmentId, studentId, item.q.id, item.q.question_key, item.value]
      );
    }

    await conn.query(
      `UPDATE assignments
          SET feedback_status = 'complete', feedback_completed_at = NOW()
        WHERE id = ?`,
      [assignmentId]
    );

    await logAttempt(assignmentId, studentId, 'feedback_submitted', { responses: toInsert.length }, conn);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Award feedback XP once — its own guarded transaction (see xp.ts).
  const xp = await awardXp(studentId, assignmentId, 'feedback', null);

  return { alreadyComplete, responsesSaved: toInsert.length, xp };
}
