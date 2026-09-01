import type { Pool } from 'mysql2/promise';

// 004 — Item 1 auth: role on the users (students) table.
// Mirrors src/migrateAuth.ts.

export async function up(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE students
       ADD COLUMN role ENUM('student','sme','qc','instructor','admin') NOT NULL DEFAULT 'student'`
  );
  await pool.query(`ALTER TABLE students ADD INDEX idx_students_role (role)`);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE students DROP INDEX idx_students_role`);
  await pool.query(`ALTER TABLE students DROP COLUMN role`);
}
