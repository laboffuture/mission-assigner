import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rootPool } from './db.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Stage 5 additive migration.
 *
 * 1. Applies src/stage5.sql (all CREATE TABLE IF NOT EXISTS — idempotent).
 * 2. Adds the new assignments columns conditionally (MySQL 8 has no
 *    `ADD COLUMN IF NOT EXISTS`, so we check information_schema first).
 * 3. Extends the xp_rules.event_type ENUM to include 'feedback' (idempotent —
 *    only rewrites the column when 'feedback' is not already a member).
 *
 * Safe to run against live data and safe to run repeatedly. It only adds.
 * Run after `npm run db:migrate` (Stage 3) and before `npm run db:seed`.
 */

const ASSIGNMENT_COLUMNS: Array<{ name: string; ddl: string }> = [
  {
    name: 'feedback_status',
    ddl: "ADD COLUMN feedback_status ENUM('not_required','pending','complete') NOT NULL DEFAULT 'pending'",
  },
  { name: 'feedback_completed_at', ddl: 'ADD COLUMN feedback_completed_at TIMESTAMP NULL' },
  { name: 'opened_at', ddl: 'ADD COLUMN opened_at TIMESTAMP NULL' },
  { name: 'time_to_submit_seconds', ddl: 'ADD COLUMN time_to_submit_seconds INT UNSIGNED NULL' },
];

async function columnExists(pool: any, dbName: string, table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows.length > 0;
}

async function columnTypeContains(
  pool: any,
  dbName: string,
  table: string,
  column: string,
  needle: string
): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows.length > 0 && String(rows[0].t).includes(needle);
}

async function main() {
  const dbName = process.env.DB_NAME ?? 'mission_demo';
  const sql = readFileSync(join(__dirname, 'stage5.sql'), 'utf8');
  const pool = rootPool();
  const applied: string[] = [];

  try {
    await pool.query(`USE \`${dbName}\``);

    // 1. Create the new tables (idempotent).
    await pool.query(sql);
    applied.push('stage5.sql tables ensured (CREATE TABLE IF NOT EXISTS)');

    // 2. Add assignments columns if missing.
    for (const col of ASSIGNMENT_COLUMNS) {
      if (await columnExists(pool, dbName, 'assignments', col.name)) continue;
      await pool.query(`ALTER TABLE assignments ${col.ddl}`);
      applied.push(`assignments.${col.name} added`);
    }

    // 3. Extend the xp_rules ENUM to include 'feedback' (only if missing).
    if (!(await columnTypeContains(pool, dbName, 'xp_rules', 'event_type', "'feedback'"))) {
      await pool.query(
        `ALTER TABLE xp_rules
           MODIFY COLUMN event_type
           ENUM('attempt','submit','correct','streak_bonus','feedback') NOT NULL`
      );
      applied.push("xp_rules.event_type ENUM extended with 'feedback'");
    }

    if (applied.length <= 1) {
      logger.info('Stage 5 migration: nothing to do (already applied).');
    } else {
      logger.info('Stage 5 migration applied:');
      for (const a of applied) logger.info(`  - ${a}`);
    }

    const [tables] = await pool.query<any[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [dbName]
    );
    logger.info(`Total tables now: ${tables.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Stage 5 migration failed');
  process.exit(1);
});
