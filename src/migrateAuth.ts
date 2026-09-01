import 'dotenv/config';
import { rootPool } from './db.js';
import { logger } from './logger.js';

const __role_ddl =
  "ADD COLUMN role ENUM('student','sme','qc','instructor','admin') NOT NULL DEFAULT 'student'";

/**
 * Item 1 (auth) additive migration — adds students.role.
 *
 * Additive and idempotent: it only adds the column if missing (MySQL 8 has no
 * `ADD COLUMN IF NOT EXISTS`, so we check information_schema first). Run after
 * db:migrate5 and before db:seed. (Item 4 will fold this into the versioned
 * migration 004_auth_roles.)
 */
async function columnExists(pool: any, dbName: string, table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows.length > 0;
}

async function main() {
  const dbName = process.env.DB_NAME ?? 'mission_demo';
  const pool = rootPool();
  try {
    await pool.query(`USE \`${dbName}\``);
    if (await columnExists(pool, dbName, 'students', 'role')) {
      logger.info('Auth migration: nothing to do (students.role already present).');
    } else {
      await pool.query(`ALTER TABLE students ${__role_ddl}`);
      await pool.query('ALTER TABLE students ADD INDEX idx_students_role (role)');
      logger.info('Auth migration applied: students.role added (+ idx_students_role).');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Auth migration failed');
  process.exit(1);
});
