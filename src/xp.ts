import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db.js';

export type XpEventType = 'attempt' | 'submit' | 'correct' | 'streak_bonus' | 'feedback';

export interface XpAward {
  awarded: boolean;      // false if skipped (no rule, or already awarded)
  points: number;
  reason?: 'no_rule' | 'already_awarded';
  totalXp: number;
}

/**
 * awardXp — award points for a single (assignment, event_type) exactly once.
 *
 *  1. Resolve the active xp_rule for (event_type, difficulty), falling back to
 *     the rule with difficulty NULL. Point values are DATA, never hardcoded.
 *  2. Guard: if an xp_events row already exists for (assignment_id, event_type),
 *     do nothing (idempotent — protects against double 'attempt'/'submit').
 *  3. Insert the xp_events row AND increment students.total_xp in ONE
 *     transaction, so the total can never drift from the event log.
 */
export async function awardXp(
  studentId: number,
  assignmentId: number | null,
  eventType: XpEventType,
  difficulty: number | null
): Promise<XpAward> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 2. Double-award guard (only meaningful when we have an assignment id).
    if (assignmentId != null) {
      const [dup] = await conn.query<any[]>(
        `SELECT id FROM xp_events
          WHERE assignment_id = ? AND event_type = ?
          LIMIT 1
          FOR UPDATE`,
        [assignmentId, eventType]
      );
      if (dup.length > 0) {
        const totalXp = await readTotal(conn, studentId);
        await conn.commit();
        return { awarded: false, points: 0, reason: 'already_awarded', totalXp };
      }
    }

    // 1. Resolve the rule: exact (event_type, difficulty) first, then the
    //    difficulty-agnostic (NULL) rule.
    const [ruleRows] = await conn.query<any[]>(
      `SELECT points FROM xp_rules
        WHERE active = TRUE AND event_type = ?
          AND (difficulty = ? OR difficulty IS NULL)
        ORDER BY (difficulty IS NULL) ASC
        LIMIT 1`,
      [eventType, difficulty]
    );
    if (ruleRows.length === 0) {
      const totalXp = await readTotal(conn, studentId);
      await conn.commit();
      return { awarded: false, points: 0, reason: 'no_rule', totalXp };
    }
    const points = Number(ruleRows[0].points);

    // 3. Insert event + increment total, atomically.
    await conn.query(
      `INSERT INTO xp_events (student_id, assignment_id, event_type, difficulty, points)
       VALUES (?, ?, ?, ?, ?)`,
      [studentId, assignmentId, eventType, difficulty, points]
    );
    await conn.query(`UPDATE students SET total_xp = total_xp + ? WHERE id = ?`, [points, studentId]);

    const totalXp = await readTotal(conn, studentId);
    await conn.commit();
    return { awarded: true, points, totalXp };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function readTotal(conn: PoolConnection, studentId: number): Promise<number> {
  const [rows] = await conn.query<any[]>(`SELECT total_xp FROM students WHERE id = ?`, [studentId]);
  return rows.length ? Number(rows[0].total_xp) : 0;
}
