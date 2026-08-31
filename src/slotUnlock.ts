import { pool } from './db.js';
import { fillSlot } from './slotFiller.js';

export interface UnlockResult {
  wasSlot: boolean;               // false if the assignment wasn't part of a week
  submittedSlotId: number | null;
  openedSlotId: number | null;    // the next slot that was opened, if any
  weekComplete: boolean;
}

/**
 * unlockNext — sequential slot progression, run AFTER an assignment is graded.
 *
 *  1. Find the week_slot holding this assignment; mark it 'submitted'.
 *  2. Find the next LOCKED, non-weekly slot by slot_index and open it, set
 *     opened_at, and fill it (fillSlot).
 *  3. If no locked slots remain, mark the student_week 'complete'.
 *
 * If the assignment is not attached to any slot (Stage 1 free-play), this is a
 * clean no-op. Weekly (is_weekly) slots are opened at publish time and are not
 * part of the sequential unlock chain.
 */
export async function unlockNext(assignmentId: number): Promise<UnlockResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [slotRows] = await conn.query<any[]>(
      `SELECT ws.id AS week_slot_id, ws.slot_index, ws.student_week_id
         FROM week_slots ws
        WHERE ws.assignment_id = ?
        FOR UPDATE`,
      [assignmentId]
    );

    if (slotRows.length === 0) {
      await conn.commit();
      return { wasSlot: false, submittedSlotId: null, openedSlotId: null, weekComplete: false };
    }

    const slot = slotRows[0];
    const studentWeekId = Number(slot.student_week_id);

    // 1. Mark the current slot submitted.
    await conn.query(`UPDATE week_slots SET status = 'submitted' WHERE id = ?`, [slot.week_slot_id]);

    // 2. Next locked, non-weekly slot by slot_index. is_weekly lives on the
    //    template; join through student_weeks -> week_template_slots.
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
      await conn.query(
        `UPDATE week_slots SET status = 'open', opened_at = NOW() WHERE id = ?`,
        [openedSlotId]
      );
    } else {
      // 3. No locked slots remain -> the week is complete.
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
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
