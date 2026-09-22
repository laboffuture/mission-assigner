// Item 4 (versioned migrations) acceptance harness.
// Builds a fresh scratch DB from the migrations and compares its schema to the
// current database; checks idempotency and a clean down-migration.
// Run: npm run verify:migrations  (tsx — imports the .ts migrator)
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { execSync, spawnSync } from 'node:child_process';
import { buildUmzug, makePool } from './src/migrator.js';

const CURRENT = process.env.DB_NAME ?? 'mission_demo';
const SCRATCH = 'mm_migr_scratch';
const CONTAINER = process.env.MYSQL_CONTAINER;
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
 *  Uses the mysqldump binary at MYSQLDUMP when set, else mysqldump on PATH.
 *  MYSQL_CONTAINER (optional) runs it inside a container instead. */
function dumpSchema(db) {
  const args = `--no-data --compact --skip-comments --skip-set-charset --no-tablespaces ${db} ${NODE_TABLES.join(' ')}`;
  const cmd = CONTAINER
    ? `docker exec ${CONTAINER} sh -c "exec mysqldump -uroot -p${DBPASS} ${args}"`
    : `"${process.env.MYSQLDUMP || 'mysqldump'}" -u${process.env.DB_USER ?? 'root'} -p${DBPASS} ` +
      `--host=${process.env.DB_HOST ?? '127.0.0.1'} --port=${process.env.DB_PORT ?? 3306} ${args}`;
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

console.log('\n[Every down migration reverses cleanly on a SEEDED database]');
{
  // The check above runs down on an EMPTY database, which is exactly the case a
  // real rollback never meets. A down that shrinks an ENUM or re-adds a
  // constraint can succeed on no rows and fail on real ones (audit A2: 003's
  // down failed once xp_rules held a 'feedback' row). So: seed the scratch
  // database with the full demo data, then step down ONE migration at a time,
  // so a failure names the migration that failed.
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'src/seed.ts'], {
    env: { ...process.env, DB_NAME: SCRATCH },
    encoding: 'utf8',
  });
  check('scratch database seeded', seed.status === 0, `(exit ${seed.status} ${(seed.stderr ?? '').slice(-200)})`);
  const [[{ n_rows: rows }]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM students) + (SELECT COUNT(*) FROM assignments) AS n_rows`,
    [SCRATCH]
  );
  const [[{ xpFeedback }]] = await pool.query(`SELECT COUNT(*) xpFeedback FROM xp_rules WHERE event_type = 'feedback'`);
  check(
    'seeded data present (incl. rows a down must preserve or convert)',
    Number(rows) > 0 && Number(xpFeedback) > 0,
    `(~${rows} rows, feedback xp_rules=${xpFeedback})`
  );

  // Curriculum mode lets a student meet the same mission again as a revision
  // (revision_seq > 0), which the pre-009 schema — UNIQUE (student_id,
  // mission_id) — cannot hold. The seed has no activity, so add one first
  // attempt and one revision, as live data would have.
  await pool.query(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, revision_seq, is_revision)
     SELECT s.id, m.id, m.version, 1, r.seq, r.seq > 0
       FROM (SELECT MIN(id) id FROM students) s
       CROSS JOIN (SELECT id, version FROM missions ORDER BY id LIMIT 1) m
       CROSS JOIN (SELECT 0 seq UNION ALL SELECT 1) r`
  );
  const downOne = async () => {
    try {
      await umzug.down({ step: 1 });
      return null;
    } catch (e) {
      return e?.cause?.message ?? e?.message ?? String(e);
    }
  };
  const selectionLogCols = async () =>
    (
      await pool.query(
        `SELECT COUNT(*) n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'selection_log' AND COLUMN_NAME IN ('chosen_session_id','pool_size')`,
        [SCRATCH]
      )
    )[0][0].n;

  const names = (await umzug.executed()).map((m) => m.name).reverse();
  for (const name of names) {
    let err = await downOne();
    if (name === '009_curriculum') {
      // With revision rows present, 009's down must REFUSE before touching
      // anything — not fail halfway and leave a schema no migration matches —
      // and must not silently delete student work to make itself succeed.
      check(
        'down 009 with revision rows refuses',
        err !== null && /revision/i.test(err),
        `(${(err ?? 'it succeeded').slice(0, 200)})`
      );
      const still = (await umzug.executed()).some((m) => m.name === name);
      check(
        '  ...and leaves the schema untouched (still at 009, selection_log columns intact)',
        still && Number(await selectionLogCols()) === 2,
        `(recorded=${still}, cols=${await selectionLogCols()})`
      );
      const [[{ revs }]] = await pool.query(`SELECT COUNT(*) revs FROM assignments WHERE revision_seq > 0`);
      check('  ...and keeps the revision rows', Number(revs) === 1, `(revision rows=${revs})`);
      // The operator's decision, made explicitly: remove the revisions, then roll back.
      await pool.query(`DELETE FROM assignments WHERE revision_seq > 0`);
      err = await downOne();
    }
    check(`down ${name} on populated data`, err === null, err ? `(${err.slice(0, 200)})` : '');
    if (err) break;
  }
  const [left] = await pool.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'`,
    [SCRATCH]
  );
  check('populated database fully reverted', left.length === 0, `(remaining=${left.map((r) => r.t).join(',')})`);
  const reup = await umzug.up();
  check(`re-up after populated down applies all ${EXPECTED}`, reup.length === EXPECTED, `(applied=${reup.length})`);
}

await pool.end();
await root.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await root.end();

console.log(`\n==== Migrations: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
