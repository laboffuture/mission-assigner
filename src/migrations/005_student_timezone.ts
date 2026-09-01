import type { Pool } from 'mysql2/promise';

// 005 — Item 7: per-student IANA timezone, used for local-day streak boundaries.
// Defaults to Asia/Kolkata (the pilot cohort). Timestamps stay UTC; only the
// day-boundary interpretation is per student.

export async function up(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE students ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'`);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE students DROP COLUMN timezone`);
}
