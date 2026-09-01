import { pool } from './db.js';
import { fillSlot } from './slotFiller.js';
import { feedbackGatesUnlock } from './config.js';

export interface UnlockResult {
  wasSlot: boolean; // false if the assignment wasn't part of a week
  submittedSlotId: number | null;
  openedSlotId: number | null; // the next slot that was opened, if any
  weekComplete: boolean;
  gatedOnFeedback: boolean; // true = next slot held back until feedback is submitted
}

/**
 * unlockNext — sequential slot progression, run AFTER an assignment is graded
 * AND again (harmlessly) after feedback is submitted.
 *
 *  1. Find the week_slot holding this assignment; mark it 'submitted'.
 *  2. GATING (Stage 5): when FEEDBACK_GATES_UNLOCK is true, the next slot is NOT
 *     opened until this assignment's feedback_status = 'complete'. The weekly
 *     slot is exempt — it never gates and is never gated. When gating is off (or
 *     the slot is weekly), behaviour matches Stage 3: open immediately.
 *  3. Open the next LOCKED, non-weekly slot by slot_index and fill it. If none
 *     remain, mark the student_week 'complete'.
 *
 * Called twice in the gated flow: once at grade time (which marks the slot
 * submitted and, if gated, stops), and once when feedback completes (which finds
 * the same slot already submitted, sees feedback_status='complete', and opens
 * the next slot). Idempotent: a second call after the next slot is already open
 * is a no-op for that slot because the query only matches 'locked' slots.
 */
export async function unlockNext(assignmentId: number): Promise<UnlockResult> {
  const gatingOn = feedbackGatesUnlock();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Current slot + whether it is the weekly slot + this assignment's feedback.
    const [slotRows] = await conn.query<any[]>(
      `SELECT ws.id AS week_slot_id, ws.slot_index, ws.student_week_id,
              COALESCE(wts.is_weekly, FALSE) AS is_weekly,
              a.feedback_status AS feedback_status
         FROM week_slots ws
         JOIN student_weeks sw ON sw.id = ws.student_week_id
         JOIN assignments a ON a.id = ws.assignment_id
         LEFT JOIN week_template_slots wts
                ON wts.template_id = sw.template_id AND wts.slot_index = ws.slot_index
        WHERE ws.assignment_id = ?
        FOR UPDATE`,
      [assignmentId]
    );

    if (slotRows.length === 0) {
      // Free-play (Stage 1) assignment — not part of a week. Clean no-op.
      await conn.commit();
      return { wasSlot: false, submittedSlotId: null, openedSlotId: null, weekComplete: false, gatedOnFeedback: false };
    }

    const slot = slotRows[0];
    const studentWeekId = Number(slot.student_week_id);
    const isWeekly = Boolean(slot.is_weekly);

    // The weekly slot, and any slot when gating is off, never requires feedback.
    if ((isWeekly || !gatingOn) && slot.feedback_status === 'pending') {
      await conn.query(`UPDATE assignments SET feedback_status = 'not_required' WHERE id = ?`, [assignmentId]);
      slot.feedback_status = 'not_required';
    }

    // 1. Mark the current slot submitted.
    await conn.query(`UPDATE week_slots SET status = 'submitted' WHERE id = ?`, [slot.week_slot_id]);

    // 2. Gate: hold the next slot until feedback is complete (non-weekly only).
    const gated = gatingOn && !isWeekly && slot.feedback_status !== 'complete';
    if (gated) {
      await conn.commit();
      return {
        wasSlot: true,
        submittedSlotId: Number(slot.week_slot_id),
        openedSlotId: null,
        weekComplete: false,
        gatedOnFeedback: true,
      };
    }

    // 3. Next locked, non-weekly slot by slot_index.
    const [nextRows] = await conn.query<any[]>(
      `SELECT ws.id AS week_slot_id, ws.slot_index
         FROM week_slots ws
         JOIN student_weeks sw ON sw.id = ws.student_week_id
         JOIN week_template_slots wts
              ON wts.template_id = sw.template_id AND wts.slot_index = ws.slot_index
        WHERE ws.student_week_id = ?
          AND ws.status = 'locked'
          AND wts.is_weekly = FALSE
        ORDER BY ws.slot_index ASC
        LIMIT 1
        FOR UPDATE`,
      [studentWeekId]
    );

    let openedSlotId: number | null = null;
    let weekComplete = false;

    if (nextRows.length > 0) {
      openedSlotId = Number(nextRows[0].week_slot_id);
      await conn.query(`UPDATE week_slots SET status = 'open', opened_at = NOW() WHERE id = ?`, [openedSlotId]);
    } else {
      // No locked slots remain -> the week is complete.
      await conn.query(`UPDATE student_weeks SET status = 'complete' WHERE id = ?`, [studentWeekId]);
      weekComplete = true;
    }

    await conn.commit();

    // fillSlot runs its own transaction; do it after the unlock commits so the
    // slot is durably 'open' first.
    if (openedSlotId != null) {
      await fillSlot(openedSlotId);
    }

    return {
      wasSlot: true,
      submittedSlotId: Number(slot.week_slot_id),
      openedSlotId,
      weekComplete,
      gatedOnFeedback: false,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
