import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rootPool } from './db.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Creates the database (if needed) and applies src/schema.sql.
 * Uses a root pool with multipleStatements enabled so the whole file runs in
 * one round-trip.
 */
async function main() {
  const dbName = process.env.DB_NAME ?? 'mission_demo';
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const pool = rootPool();

  try {
    await pool.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
    await pool.query(`USE \`${dbName}\``);
    await pool.query(sql);

    const [tables] = await pool.query<any[]>(
      `SELECT TABLE_NAME AS name
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [dbName]
    );
    logger.info(
      { database: dbName, tableCount: tables.length, tables: tables.map((t) => t.name) },
      'schema applied'
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'schema failed');
  process.exit(1);
});
