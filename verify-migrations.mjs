// Item 4 (versioned migrations) acceptance harness.
// Builds a fresh scratch DB from the migrations and compares its schema to the
// current database; checks idempotency and a clean down-migration.
// Run: npm run verify:migrations  (tsx — imports the .ts migrator)
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { execSync } from 'node:child_process';
import { buildUmzug, makePool } from './src/migrator.js';

const CURRENT = process.env.DB_NAME ?? 'mission_demo';
const SCRATCH = 'mm_migr_scratch';
const CONTAINER = process.env.MYSQL_CONTAINER || 'mission-mysql';
const DBPASS = process.env.DB_PASS ?? 'devpass';

let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// Every table in the database, because the migration chain now owns every table.
//
// This list used to exclude content_chunks on the grounds that "the Stage 2
// Python pipeline manages its own tables". That carve-out is what let the drift
// hide: it excused the pipeline's *table*, but the pipeline was also adding four
// columns and an index to `missions`, which was never excluded — so this harness
// failed on any second consecutive run and passed only when it happened to run
// before the pipeline stage. Migration 010 adopted all six objects and the
// pipeline no longer creates schema, so there is nothing left to carve out.
// Anything in the database that is not below is now a genuine drift finding.
const NODE_TABLES = [
  'assignments',
  'assistance_events',
  'attempt_logs',
  'content_chunks',
  'feedback_questions',
  'feedback_responses',
  'idempotency_keys',
  'level_events',
  'mission_options',
  'mission_tags',
  'missions',
  'segment_prerequisites',
  'segments',
  'selection_log',
  'student_courses',
  'student_interests',
  'student_weeks',
  'students',
  'week_slots',
  'week_template_slots',
  'week_templates',
  'xp_events',
  'xp_rules',
  // 009_curriculum
  'credits',
  'projects',
  'sessions',
  'student_positions',
  'tracks',
];

/** Dump the migration-owned tables (no data), normalised.
 *  Uses the mysqldump binary at MYSQLDUMP when set (a local MySQL install);
 *  otherwise the one inside the Docker container. */
function dumpSchema(db) {
  const args = `--no-data --compact --skip-comments --skip-set-charset --no-tablespaces ${db} ${NODE_TABLES.join(' ')}`;
  const cmd = process.env.MYSQLDUMP
    ? `"${process.env.MYSQLDUMP}" -u${process.env.DB_USER ?? 'root'} -p${DBPASS} ` +
      `--host=${process.env.DB_HOST ?? '127.0.0.1'} --port=${process.env.DB_PORT ?? 3306} ${args}`
    : `docker exec ${CONTAINER} sh -c "exec mysqldump -uroot -p${DBPASS} ${args}"`;
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out
    .split('\n')
    .filter((l) => !l.startsWith('/*') && !l.startsWith('--') && l.trim() !== '')
    .map((l) => l.replace(/ AUTO_INCREMENT=\d+/g, ''))
    .join('\n')
    .trim();
}

const root = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: DBPASS,
  multipleStatements: true,
});
await root.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await root.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

const pool = makePool(SCRATCH);
const umzug = buildUmzug(pool);

const EXPECTED = 10;
console.log('\n[Migrating a fresh database applies every migration]');
const applied1 = await umzug.up();
check(`all ${EXPECTED} migrations applied`, applied1.length === EXPECTED, `(applied=${applied1.length})`);
const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM schema_migrations`);
check(`schema_migrations records ${EXPECTED} rows`, Number(n) === EXPECTED, `(rows=${n})`);
const [tsRows] = await pool.query(`SELECT applied_at FROM schema_migrations WHERE applied_at IS NOT NULL`);
check('each recorded with a timestamp', tsRows.length === EXPECTED);

console.log('\n[Running migrate twice is a no-op]');
const applied2 = await umzug.up();
check('second up applies nothing', applied2.length === 0, `(applied=${applied2.length})`);

console.log('\n[A fresh migrated schema is identical to the current database]');
{
  const scratchSchema = dumpSchema(SCRATCH);
  const currentSchema = dumpSchema(CURRENT);
  const identical = scratchSchema === currentSchema;
  check('fresh migrated schema == current schema', identical);
  if (!identical) {
    const a = scratchSchema.split('\n');
    const b = currentSchema.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`   first diff @ line ${i}:\n    scratch: ${a[i]}\n    current: ${b[i]}`);
        break;
      }
    }
  }
}

console.log('\n[No table exists outside the migration chain]');
{
  // The dump above compares only the tables named in NODE_TABLES, so a brand-new
  // unknown table would not show up there. This is the check that actually makes
  // "the migration chain owns every table" enforceable: anything present in the
  // live database and absent from the list is drift, which is precisely how the
  // pipeline's content_chunks went unnoticed.
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
    [CURRENT]
  );
  const unknown = rows.map((r) => r.t).filter((t) => !NODE_TABLES.includes(t));
  check('every table in the live database is migration-owned', unknown.length === 0, `(unknown=${unknown.join(',')})`);
}

console.log('\n[A down migration reverses cleanly]');
{
  const reverted = await umzug.down({ to: 0 });
  check(`all ${EXPECTED} migrations reverted`, reverted.length === EXPECTED, `(reverted=${reverted.length})`);
  const [tables] = await pool.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
    [SCRATCH]
  );
  check('all application tables dropped', tables.length === 0, `(remaining=${tables.map((r) => r.t).join(',')})`);
  // ...and re-appliable
  const reup = await umzug.up();
  check(`re-up after down applies all ${EXPECTED} again`, reup.length === EXPECTED, `(applied=${reup.length})`);
}

await pool.end();
await root.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await root.end();

console.log(`\n==== Migrations: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
