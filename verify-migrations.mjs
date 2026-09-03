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

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// The tables the Node migrations own. The Stage 2 Python pipeline manages its
// own tables (e.g. content_chunks) in the same database; those are out of scope
// for this comparison, so we diff exactly the migration-owned set.
const NODE_TABLES = [
  'assignments', 'assistance_events', 'attempt_logs', 'feedback_questions', 'feedback_responses',
  'idempotency_keys', 'level_events', 'mission_options', 'mission_tags', 'missions',
  'segment_prerequisites', 'segments', 'selection_log', 'student_courses', 'student_interests',
  'student_weeks', 'students', 'week_slots', 'week_template_slots', 'week_templates',
  'xp_events', 'xp_rules',
];

/** Dump the migration-owned tables (no data) via the container's mysqldump, normalised. */
function dumpSchema(db) {
  const cmd =
    `docker exec ${CONTAINER} sh -c "exec mysqldump -uroot -p${DBPASS} --no-data --compact ` +
    `--skip-comments --skip-set-charset --no-tablespaces ${db} ${NODE_TABLES.join(' ')}"`;
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out
    .split('\n')
    .filter((l) => !l.startsWith('/*') && !l.startsWith('--') && l.trim() !== '')
    .map((l) => l.replace(/ AUTO_INCREMENT=\d+/g, ''))
    .join('\n')
    .trim();
}

const root = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: DBPASS, multipleStatements: true,
});
await root.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await root.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);

const pool = makePool(SCRATCH);
const umzug = buildUmzug(pool);

const EXPECTED = 8;
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
