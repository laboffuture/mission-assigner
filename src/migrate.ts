import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rootPool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Stage 3 additive migration.
 *
 * 1. Applies src/stage3.sql (all CREATE TABLE IF NOT EXISTS — idempotent).
 * 2. Adds the new students columns conditionally (MySQL 8 has no
 *    `ADD COLUMN IF NOT EXISTS`, so we check information_schema first).
 * 3. Adds the segment_id index + FK conditionally.
 *
 * Safe to run against live data and safe to run repeatedly. It only adds.
 */

const STUDENT_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'segment_id', ddl: 'ADD COLUMN segment_id BIGINT UNSIGNED NULL' },
  { name: 'total_xp', ddl: 'ADD COLUMN total_xp INT UNSIGNED NOT NULL DEFAULT 0' },
  {
    name: 'placement_status',
    ddl: "ADD COLUMN placement_status ENUM('pending','in_progress','complete') NOT NULL DEFAULT 'pending'",
  },
  { name: 'stall_count', ddl: 'ADD COLUMN stall_count TINYINT UNSIGNED NOT NULL DEFAULT 0' },
];

async function columnExists(pool: any, dbName: string, table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows.length > 0;
}

async function indexExists(pool: any, dbName: string, table: string, index: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [dbName, table, index]
  );
  return rows.length > 0;
}

async function fkExists(pool: any, dbName: string, table: string, constraint: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [dbName, table, constraint]
  );
  return rows.length > 0;
}

async function main() {
  const dbName = process.env.DB_NAME ?? 'mission_demo';
  const sql = readFileSync(join(__dirname, 'stage3.sql'), 'utf8');
  const pool = rootPool();
  const applied: string[] = [];

  try {
    await pool.query(`USE \`${dbName}\``);

    // 1. Create the new tables (idempotent).
    await pool.query(sql);
    applied.push('stage3.sql tables ensured (CREATE TABLE IF NOT EXISTS)');

    // 2. Add students columns if missing.
    for (const col of STUDENT_COLUMNS) {
      if (await columnExists(pool, dbName, 'students', col.name)) continue;
      await pool.query(`ALTER TABLE students ${col.ddl}`);
      applied.push(`students.${col.name} added`);
    }

    // 3. Index on segment_id.
    if (!(await indexExists(pool, dbName, 'students', 'idx_students_segment'))) {
      await pool.query('ALTER TABLE students ADD INDEX idx_students_segment (segment_id)');
      applied.push('index idx_students_segment added');
    }

    // 4. FK students.segment_id -> segments (nullable, SET NULL on delete).
    if (!(await fkExists(pool, dbName, 'students', 'fk_students_segment'))) {
      await pool.query(
        `ALTER TABLE students
           ADD CONSTRAINT fk_students_segment
           FOREIGN KEY (segment_id) REFERENCES segments (id) ON DELETE SET NULL`
      );
      applied.push('fk_students_segment added');
    }

    if (applied.length === 0) {
      console.log('Stage 3 migration: nothing to do (already applied).');
    } else {
      console.log('Stage 3 migration applied:');
      for (const a of applied) console.log(`  - ${a}`);
    }

    const [tables] = await pool.query<any[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [dbName]
    );
    console.log(`Total tables now: ${tables.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
