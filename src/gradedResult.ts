import { pool } from './db.js';
import { feedbackGatesUnlock } from './config.js';
import type { SubmitResponse } from './dto.js';
import type { ScoreBand } from './grading.js';
import type { UnlockResult } from './slotUnlock.js';

/**
 * Rebuild the result of an assignment that was ALREADY graded, from what is
 * stored — for the submit that arrives after the first one was graded but its
 * response never reached the student (dropped connection, closed laptop). They
 * then see their original result, marked `already_submitted`, instead of an
 * error about an assignment that "is not open".
 *
 * Reads only. In particular it does NOT call unlockNext(): the slot progression
 * already ran for this assignment when it was graded, and running it again now
 * would open a FURTHER locked slot. The unlock reported here is the current
 * state of this assignment's slot, not a new action.
 */
export async function loadGradedResult(
  assignmentId: number
): Promise<(SubmitResponse & { already_submitted: true; selected_option_key: string }) | null> {
  const [[a]] = await pool.query<any[]>(
    `SELECT a.id, a.student_id, a.status, a.response, a.score_pct, a.score_band, a.feedback_status,
            m.answer_key, s.total_xp
       FROM assignments a
       JOIN missions m ON m.id = a.mission_id
       JOIN students s ON s.id = a.student_id
      WHERE a.id = ?`,
    [assignmentId]
  );
  if (!a || a.status !== 'graded') return null;

  const answerKey = typeof a.answer_key === 'string' ? JSON.parse(a.answer_key || '{}') : (a.answer_key ?? {});
  const response = typeof a.response === 'string' ? JSON.parse(a.response || '{}') : (a.response ?? {});
  const selected = String(response?.selected ?? '');

  // The XP actually awarded for this assignment (0 rows = none was due).
  const [xpRows] = await pool.query<any[]>(
    `SELECT event_type, points FROM xp_events WHERE assignment_id = ? AND event_type IN ('submit','correct')`,
    [assignmentId]
  );
  const totalXp = Number(a.total_xp ?? 0);
  const award = (type: string) => {
    const row = xpRows.find((r) => r.event_type === type);
    return row ? { awarded: true, points: Number(row.points), totalXp } : null;
  };
  const submitAward = award('submit') ?? { awarded: false, points: 0, reason: 'already_awarded' as const, totalXp };
  const correctAward = award('correct');

  // The ladder move this submission caused, if it moved at all.
  const [[lvl]] = await pool.query<any[]>(
    `SELECT from_level, to_level, reason FROM level_events WHERE assignment_id = ? ORDER BY id DESC LIMIT 1`,
    [assignmentId]
  );
  const [[cur]] = await pool.query<any[]>(`SELECT current_level FROM students WHERE id = ?`, [a.student_id]);
  const level = lvl
    ? { from: Number(lvl.from_level), to: Number(lvl.to_level), reason: String(lvl.reason) }
    : { from: Number(cur?.current_level ?? 0), to: Number(cur?.current_level ?? 0), reason: 'no_change' };

  // The slot's CURRENT state — read, not re-run.
  const [[slot]] = await pool.query<any[]>(
    `SELECT ws.id AS week_slot_id, ws.student_week_id, sw.status AS week_status,
            COALESCE(wts.is_weekly, FALSE) AS is_weekly
       FROM week_slots ws
       JOIN student_weeks sw ON sw.id = ws.student_week_id
       LEFT JOIN week_template_slots wts ON wts.template_id = sw.template_id AND wts.slot_index = ws.slot_index
      WHERE ws.assignment_id = ?`,
    [assignmentId]
  );
  let unlock: UnlockResult = {
    wasSlot: false,
    submittedSlotId: null,
    openedSlotId: null,
    weekComplete: false,
    gatedOnFeedback: false,
  };
  if (slot) {
    const gated = feedbackGatesUnlock() && !Number(slot.is_weekly) && a.feedback_status !== 'complete';
    const [[open]] = await pool.query<any[]>(
      `SELECT id FROM week_slots WHERE student_week_id = ? AND status = 'open' ORDER BY slot_index ASC LIMIT 1`,
      [slot.student_week_id]
    );
    unlock = {
      wasSlot: true,
      submittedSlotId: Number(slot.week_slot_id),
      openedSlotId: gated ? null : (open?.id ?? null),
      weekComplete: slot.week_status === 'complete',
      gatedOnFeedback: gated,
    };
  }

  return {
    assignment_id: Number(a.id),
    correct: selected !== '' && selected === String(answerKey.correct ?? ''),
    score_band: a.score_band as ScoreBand,
    correct_option_key: String(answerKey.correct ?? ''),
    explanation: String(answerKey.explanation ?? ''),
    level,
    xp: { submit: submitAward, correct: correctAward, points_earned: 0, total_xp: totalXp },
    unlock,
    feedback: {
      required: a.feedback_status !== 'not_required' && a.feedback_status !== 'complete',
      status: a.feedback_status,
      gates_unlock: feedbackGatesUnlock(),
    },
    already_submitted: true,
    /** The answer the student actually submitted the first time. */
    selected_option_key: selected,
  };
}
