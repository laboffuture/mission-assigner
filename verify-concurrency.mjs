// Item 8 (idempotency & concurrency) acceptance harness.
// Run: npm run verify:concurrency  (tsx — imports .ts)
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { assignSegment } from './src/segmentation.js';
import { applyColdStart } from './src/coldstart.js';
import { publishWeek } from './src/weekPublisher.js';

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
// Test the unlock advance directly (gating off), then restore the default.
async function setGating(enabled) {
  await fetch(`${BASE}/api/test/feedback-gating`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
}
await setGating(false);
async function newStudent(name, courses) {
  const [r] = await db.query(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES (?,15,'Computer Science',0,'pending')`, [name]);
  const id = r.insertId;
  for (const c of courses) await db.query(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?,?,NOW())`, [id, c]);
  await assignSegment(id); await applyColdStart(id);
  return id;
}
async function openSlot1(sid) {
  const wk = await (await fetch(`${BASE}/api/week/${sid}`, { headers: { 'X-User-Id': String(sid) } })).json();
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const o = await (await fetch(`${BASE}/api/slot/${slot1.slot_id}/open`, { method: 'POST', headers: { 'X-User-Id': String(sid) } })).json();
  return o.assignment_id;
}
async function answerKey(aid) {
  const [[row]] = await db.query(`SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id=a.mission_id WHERE a.id=?`, [aid]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return ak.correct;
}
function submit(sid, aid, selected, key) {
  const headers = { 'Content-Type': 'application/json', 'X-User-Id': String(sid) };
  if (key) headers['Idempotency-Key'] = key;
  return fetch(`${BASE}/api/submit`, { method: 'POST', headers, body: JSON.stringify({ assignmentId: aid, selected }) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const countXp = async (aid, ev) => Number((await db.query(`SELECT COUNT(*) n FROM xp_events WHERE assignment_id=? AND event_type=?`, [aid, ev]))[0][0].n);
const countLevel = async (aid) => Number((await db.query(`SELECT COUNT(*) n FROM level_events WHERE assignment_id=?`, [aid]))[0][0].n);
const slot2Status = async (sid) => {
  const [[row]] = await db.query(
    `SELECT ws.status FROM week_slots ws JOIN student_weeks sw ON sw.id=ws.student_week_id WHERE sw.student_id=? AND ws.slot_index=2 ORDER BY sw.id DESC LIMIT 1`, [sid]);
  return row ? row.status : null;
};

console.log('\n[Two simultaneous submits with the SAME Idempotency-Key -> one grade, one replay]');
{
  const sid = await newStudent('CC-idem', ['CS-101']);
  await publishWeek(sid, '2026-12-07');
  const aid = await openSlot1(sid);
  const correct = await answerKey(aid);
  const key = 'race-key-' + aid;
  const [a, b] = await Promise.all([submit(sid, aid, correct, key), submit(sid, aid, correct, key)]);
  check('both requests succeed (200)', a.status === 200 && b.status === 200, `(a=${a.status}, b=${b.status})`);
  check('exactly one "submit" XP event', (await countXp(aid, 'submit')) === 1, `(n=${await countXp(aid, 'submit')})`);
  check('exactly one "correct" XP event', (await countXp(aid, 'correct')) === 1, `(n=${await countXp(aid, 'correct')})`);
  check('exactly one level_event', (await countLevel(aid)) === 1, `(n=${await countLevel(aid)})`);
  check('next slot unlocked exactly once (slot 2 open)', (await slot2Status(sid)) === 'open', `(status=${await slot2Status(sid)})`);
  const replays = [a, b].filter((r) => r.body && r.body.idempotent_replay).length;
  check('one response is an idempotent replay of the other', replays === 1, `(replays=${replays})`);
  check('both responses agree the answer was correct', a.body?.correct === true && b.body?.correct === true);
}

console.log('\n[Two simultaneous submits with NO key -> lock lets exactly one through]');
{
  const sid = await newStudent('CC-nokey', ['CS-101']);
  await publishWeek(sid, '2026-12-07');
  const aid = await openSlot1(sid);
  const correct = await answerKey(aid);
  const [a, b] = await Promise.all([submit(sid, aid, correct), submit(sid, aid, correct)]);
  const statuses = [a.status, b.status].sort();
  check('one succeeds (200), one rejected (400 not-open)', JSON.stringify(statuses) === JSON.stringify([200, 400]), `(statuses=${statuses})`);
  check('still exactly one "submit" XP event', (await countXp(aid, 'submit')) === 1, `(n=${await countXp(aid, 'submit')})`);
  check('still exactly one "correct" XP event', (await countXp(aid, 'correct')) === 1, `(n=${await countXp(aid, 'correct')})`);
  check('still exactly one level_event', (await countLevel(aid)) === 1, `(n=${await countLevel(aid)})`);
}

await db.query(`DELETE FROM students WHERE display_name LIKE 'CC-%'`);
await setGating(true); // restore the default gating state
console.log(`\n==== Concurrency: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
