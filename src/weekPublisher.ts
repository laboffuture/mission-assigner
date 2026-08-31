import type { PoolConnection } from 'mysql2/promise';
import { pool } from './db.js';

export interface PublishedSlot {
  id: number;
  slot_index: number;
  day_label: string;
  mission_type: string;
  time_band: string;
  status: 'locked' | 'open' | 'submitted';
}

export interface PublishResult {
  created: boolean;          // false if this week already existed (no-op)
  studentWeekId: number;
  templateId: number;
  weekStart: string;
  slots: PublishedSlot[];
}

/**
 * publishWeek — materialise a week for a student from the active template.
 *
 *  1. Pick the active week_template for the student's subject + segment; a
 *     segment-specific template wins over the subject-wide (segment_id NULL) one.
 *  2. Create a student_weeks row.
 *  3. Create one week_slots row per template slot (copy day_label, mission_type,
 *     time_band). Missions are NOT selected here — that is slotFiller's job.
 *  4. Slot 1 -> 'open'; every is_weekly slot -> 'open'; the rest 'locked'.
 *
 * IDEMPOTENT: a second call for the same (student, week_start) is a no-op. The
 * UNIQUE KEY uq_student_week is the backstop; we check first to avoid a throw.
 */
export async function publishWeek(studentId: number, weekStart: string): Promise<PublishResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Idempotency: already published?
    const [existing] = await conn.query<any[]>(
      `SELECT id, template_id FROM student_weeks
        WHERE student_id = ? AND week_start = ?
        FOR UPDATE`,
      [studentId, weekStart]
    );
    if (existing.length > 0) {
      const studentWeekId = Number(existing[0].id);
      const slots = await loadSlots(conn, studentWeekId);
      await conn.commit();
      return {
        created: false,
        studentWeekId,
        templateId: Number(existing[0].template_id),
        weekStart,
        slots,
      };
    }

    // Student's subject + segment.
    const [studentRows] = await conn.query<any[]>(
      `SELECT subject, segment_id FROM students WHERE id = ?`,
      [studentId]
    );
    if (studentRows.length === 0) throw new Error(`Student ${studentId} not found`);
    const { subject, segment_id } = studentRows[0];

    // Template: segment-specific wins over subject-wide (NULL segment).
    const [templates] = await conn.query<any[]>(
      `SELECT id FROM week_templates
        WHERE active = TRUE AND subject = ?
          AND (segment_id = ? OR segment_id IS NULL)
        ORDER BY (segment_id IS NULL) ASC, id DESC
        LIMIT 1`,
      [subject, segment_id]
    );
    if (templates.length === 0) {
      throw new Error(`No active week_template for subject "${subject}" (segment ${segment_id ?? 'none'})`);
    }
    const templateId = Number(templates[0].id);

    // Create the student_weeks row.
    const [wk] = await conn.query<any>(
      `INSERT INTO student_weeks (student_id, template_id, week_start, status)
       VALUES (?, ?, ?, 'active')`,
      [studentId, templateId, weekStart]
    );
    const studentWeekId = Number(wk.insertId);

    // Copy template slots -> week_slots.
    const [templateSlots] = await conn.query<any[]>(
      `SELECT slot_index, day_label, mission_type, time_band, is_weekly
         FROM week_template_slots
        WHERE template_id = ?
        ORDER BY slot_index ASC`,
      [templateId]
    );

    for (const ts of templateSlots) {
      // Slot 1 opens, weekly slots open, all others locked.
      const status = Number(ts.slot_index) === 1 || ts.is_weekly ? 'open' : 'locked';
      const openedAt = status === 'open' ? new Date() : null;
      await conn.query(
        `INSERT INTO week_slots
           (student_week_id, slot_index, day_label, mission_type, time_band, status, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [studentWeekId, ts.slot_index, ts.day_label, ts.mission_type, ts.time_band, status, openedAt]
      );
    }

    const slots = await loadSlots(conn, studentWeekId);
    await conn.commit();

    return { created: true, studentWeekId, templateId, weekStart, slots };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function loadSlots(conn: PoolConnection, studentWeekId: number): Promise<PublishedSlot[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT id, slot_index, day_label, mission_type, time_band, status
       FROM week_slots
      WHERE student_week_id = ?
      ORDER BY slot_index ASC`,
    [studentWeekId]
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    slot_index: Number(r.slot_index),
    day_label: r.day_label,
    mission_type: r.mission_type,
    time_band: r.time_band,
    status: r.status,
  }));
}
