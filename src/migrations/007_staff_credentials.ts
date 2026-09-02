import type { Pool } from 'mysql2/promise';

// 007 — staff login credentials on the users (students) table.
//
// Students authenticate via Moodle SSO (LTI launch) and never have a local
// password. Staff (sme/qc/admin/instructor) sign in to the hosted app directly,
// so they get a unique username and a bcrypt password_hash. Both columns are
// NULL for students; username is UNIQUE where present.

export async function up(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE students
       ADD COLUMN username VARCHAR(64) NULL,
       ADD COLUMN password_hash VARCHAR(255) NULL`
  );
  // UNIQUE index tolerates multiple NULLs (students) but enforces distinct
  // usernames among staff.
  await pool.query(`ALTER TABLE students ADD UNIQUE INDEX uq_students_username (username)`);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE students DROP INDEX uq_students_username`);
  await pool.query(`ALTER TABLE students DROP COLUMN password_hash, DROP COLUMN username`);
}
