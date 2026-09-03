// Fixture: insert one OPEN assistance_event for a student, with 3 real failed
// graded assignments as context. Prints the new event id on stdout.
// Usage: node e2e/fixtures/make-assistance-event.mjs <studentId>
// Loads the API's .env for DB credentials (run from web/, the repo is one up).
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..'); // web/e2e/fixtures -> mission-demo
config({ path: resolve(repoRoot, '.env') });

const studentId = Number(process.argv[2]);
if (!Number.isInteger(studentId)) {
  console.error('usage: make-assistance-event.mjs <studentId>');
  process.exit(1);
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const [missions] = await db.query(`SELECT id, version, answer_key FROM missions ORDER BY id LIMIT 3`);
const refs = [];
for (let i = 0; i < missions.length; i++) {
  const m = missions[i];
  let key = m.answer_key;
  if (typeof key === 'string') key = JSON.parse(key);
  const wrong = ['a', 'b', 'c', 'd'].find((k) => k !== key.correct);
  const [tagRows] = await db.query(`SELECT tag FROM mission_tags WHERE mission_id = ?`, [m.id]);
  const [r] = await db.query(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, score_band, score_pct, response, submitted_at, graded_at)
     VALUES (?,?,?,0,'graded','fail',0, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE), UTC_TIMESTAMP())`,
    [studentId, m.id, m.version, JSON.stringify({ selected: wrong }), (3 - i) * 5]
  );
  refs.push({ assignment_id: r.insertId, mission_id: m.id, selected: wrong, tags: tagRows.map((t) => t.tag) });
}
const tags = [...new Set(refs.flatMap((f) => f.tags))];
const ctx = { failed_assignments: refs, tags_involved: tags };
const [ev] = await db.query(
  `INSERT INTO assistance_events (student_id, trigger_reason, level_at_trigger, context, status, created_at)
   VALUES (?, 'stall_threshold', 0, ?, 'open', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY))`,
  [studentId, JSON.stringify(ctx)]
);
await db.end();
process.stdout.write(String(ev.insertId));
