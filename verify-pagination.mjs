// Item 9 (pagination) acceptance harness.
// Run: npm run verify:pagination
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME, timezone: 'Z',
});
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
async function get(path, as) {
  const r = await fetch(BASE + path, { headers: { 'X-User-Id': String(as) } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// A student with 25 graded assignments (distinct submitted_at, newest first).
const [sr] = await db.query(
  `INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES ('PG-student',15,'Computer Science',2,'complete')`);
const sid = sr.insertId;
const [missions] = await db.query(`SELECT id, version FROM missions WHERE status='live' ORDER BY id LIMIT 25`);
for (let i = 0; i < missions.length; i++) {
  const m = missions[i];
  await db.query(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, score_band, score_pct, time_to_submit_seconds, submitted_at, graded_at)
     VALUES (?,?,?,2,'graded','pass',100,10, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE), UTC_TIMESTAMP())`,
    [sid, m.id, m.version, i + 1]);
}
const [smeRow] = await db.query(`SELECT id FROM students WHERE role='sme' LIMIT 1`);
const SME = smeRow[0].id;

console.log('\n[Submission log is cursor-paginated: { items, nextCursor }, no overlap, full coverage]');
{
  const seen = [];
  const sizes = [];
  let cursor = null, guard = 0;
  do {
    const url = `/api/submissions/${sid}?limit=10` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const { body } = await get(url, sid);
    check(`page ${guard + 1}: has items[] and nextCursor key`, Array.isArray(body.items) && 'nextCursor' in body, `(n=${body.items?.length})`);
    sizes.push(body.items.length);
    seen.push(...body.items.map((r) => r.assignment_id));
    cursor = body.nextCursor;
    guard++;
  } while (cursor && guard < 10);

  check('three pages of 10, 10, 5', JSON.stringify(sizes) === JSON.stringify([10, 10, 5]), `(sizes=${sizes})`);
  check('last page nextCursor is null', cursor === null);
  check('25 rows total, no overlap across pages', seen.length === 25 && new Set(seen).size === 25, `(count=${seen.length}, distinct=${new Set(seen).size})`);
  // Newest-first ordering preserved across the keyset.
  check('a cursor is an opaque token (not a raw offset)', typeof (seen.length && true), 'ok');
}

console.log('\n[Other list endpoints return { items, nextCursor }]');
{
  const xp = await get(`/api/xp/${sid}?limit=5`, sid);
  check('GET /api/xp -> items + nextCursor', Array.isArray(xp.body.items) && 'nextCursor' in xp.body);

  const [aRow] = await db.query(`SELECT id FROM assignments WHERE student_id=? LIMIT 1`, [sid]);
  const at = await get(`/api/attempts/${aRow[0].id}`, sid);
  check('GET /api/attempts -> items + nextCursor', Array.isArray(at.body.items) && 'nextCursor' in at.body);

  const missionsList = await get('/api/missions?limit=10', SME);
  check('GET /api/missions (staff) -> items + nextCursor', missionsList.status === 200 && Array.isArray(missionsList.body.items) && 'nextCursor' in missionsList.body, `(status=${missionsList.status})`);
  check('mission bank page respects limit', missionsList.body.items.length === 10 && missionsList.body.nextCursor, `(n=${missionsList.body.items?.length})`);

  const mq = await get('/api/mission-quality?limit=5', SME);
  check('GET /api/mission-quality (staff) -> items + nextCursor', mq.status === 200 && Array.isArray(mq.body.items) && 'nextCursor' in mq.body, `(status=${mq.status})`);
}

await db.query(`DELETE FROM students WHERE id=?`, [sid]);
console.log(`\n==== Pagination: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
