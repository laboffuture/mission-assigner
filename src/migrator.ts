import 'dotenv/config';
import mysql from 'mysql2/promise';
import { dbPort } from './dbConfig.js';
import type { Pool } from 'mysql2/promise';
import { Umzug } from 'umzug';
import { logger } from './logger.js';
import { refuseDestructiveInProduction } from './destructiveGuard.js';
import * as m001 from './migrations/001_initial_schema.js';
import * as m002 from './migrations/002_stage3_segments_weeks_xp.js';
import * as m003 from './migrations/003_stage5_feedback_tracking.js';
import * as m004 from './migrations/004_auth_roles.js';
import * as m005 from './migrations/005_student_timezone.js';
import * as m006 from './migrations/006_idempotency_keys.js';
import * as m007 from './migrations/007_staff_credentials.js';
import * as m008 from './migrations/008_assistance_workflow.js';
import * as m009 from './migrations/009_curriculum.js';
import * as m010 from './migrations/010_adopt_pipeline_schema.js';
import * as m011 from './migrations/011_idempotency_request_hash.js';
import * as m012 from './migrations/012_hours.js';

/**
 * Versioned migrations (Item 4).
 *
 * Runner: umzug. Chosen over db-migrate because it is a thin, framework-agnostic
 * migration engine — it does not impose an ORM or its own DB driver, so every
 * migration is plain mysql2/promise raw SQL (matching the stack). The only piece
 * we supply is a tiny storage that records applied migrations in a
 * `schema_migrations` table via mysql2. `npm run db:migrate` brings any database
 * to current and is a no-op when already current.
 */

interface Migration {
  name: string;
  up: (pool: Pool) => Promise<void>;
  down: (pool: Pool) => Promise<void>;
}

/** Every migration this build knows about, in order. Exported so /readyz can
 *  say whether the database is at the schema this code expects. */
const MIGRATIONS: Migration[] = [
  { name: '001_initial_schema', up: m001.up, down: m001.down },
  { name: '002_stage3_segments_weeks_xp', up: m002.up, down: m002.down },
  { name: '003_stage5_feedback_tracking', up: m003.up, down: m003.down },
  { name: '004_auth_roles', up: m004.up, down: m004.down },
  { name: '005_student_timezone', up: m005.up, down: m005.down },
  { name: '006_idempotency_keys', up: m006.up, down: m006.down },
  { name: '007_staff_credentials', up: m007.up, down: m007.down },
  { name: '008_assistance_workflow', up: m008.up, down: m008.down },
  { name: '009_curriculum', up: m009.up, down: m009.down },
  { name: '010_adopt_pipeline_schema', up: m010.up, down: m010.down },
  { name: '011_idempotency_request_hash', up: m011.up, down: m011.down },
  { name: '012_hours', up: m012.up, down: m012.down },
];

export const MIGRATION_NAMES = MIGRATIONS.map((m) => m.name);

/** A pool bound to `dbName` with multi-statement SQL enabled (migrations need it). */
export function makePool(dbName: string): Pool {
  const p = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    database: dbName,
    port: dbPort(),
    timezone: 'Z',
    multipleStatements: true,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
  p.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return p;
}

/** Records applied migrations in schema_migrations(name, applied_at). */
class MySQLStorage {
  constructor(private pool: Pool) {}
  private async ensure(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        VARCHAR(255) NOT NULL,
         applied_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (name)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    );
  }
  async logMigration(params: { name: string }): Promise<void> {
    await this.ensure();
    await this.pool.query(`INSERT INTO schema_migrations (name) VALUES (?)`, [params.name]);
  }
  async unlogMigration(params: { name: string }): Promise<void> {
    await this.ensure();
    await this.pool.query(`DELETE FROM schema_migrations WHERE name = ?`, [params.name]);
  }
  async executed(): Promise<string[]> {
    await this.ensure();
    const [rows] = await this.pool.query<any[]>(`SELECT name FROM schema_migrations ORDER BY name`);
    return rows.map((r) => r.name as string);
  }
}

export function buildUmzug(pool: Pool) {
  return new Umzug<Pool>({
    migrations: MIGRATIONS.map((mig) => ({
      name: mig.name,
      up: async ({ context }) => mig.up(context),
      down: async ({ context }) => mig.down(context),
    })),
    context: pool,
    storage: new MySQLStorage(pool),
    logger: undefined,
  });
}

/** Ensure the database exists (migration 001 assumes it does). */
async function ensureDatabase(dbName: string): Promise<void> {
  const root = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASS ?? '',
    port: dbPort(),
    multipleStatements: true,
  });
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await root.end();
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  // Down migrations drop tables and columns. Refuse under production before connecting.
  if (cmd === 'down' || cmd === 'down:all')
    refuseDestructiveInProduction(`run migrate ${cmd} (it drops tables and columns)`);
  const dbName = process.env.DB_NAME ?? 'mission_demo';
  await ensureDatabase(dbName);
  const pool = makePool(dbName);
  const umzug = buildUmzug(pool);
  try {
    if (cmd === 'up') {
      const applied = await umzug.up();
      logger.info(
        { applied: applied.map((m) => m.name) },
        applied.length ? 'migrations applied' : 'already up to date'
      );
    } else if (cmd === 'down') {
      const reverted = await umzug.down();
      logger.info({ reverted: reverted.map((m) => m.name) }, 'reverted last migration');
    } else if (cmd === 'down:all') {
      const reverted = await umzug.down({ to: 0 as any });
      logger.info({ reverted: reverted.map((m) => m.name) }, 'reverted all migrations');
    } else if (cmd === 'status') {
      const executed = (await umzug.executed()).map((m) => m.name);
      const pending = (await umzug.pending()).map((m) => m.name);
      logger.info({ executed, pending }, 'migration status');
    } else {
      logger.error({ cmd }, 'unknown migrator command (use: up | down | down:all | status)');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Run as a CLI only (not when imported by a test harness).
const isCli = process.argv[1] && /migrator\.(ts|js|mjs)$/.test(process.argv[1]);
if (isCli) {
  main().catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exit(1);
  });
}
