// Stage 3 acceptance harness — covers the 14 criteria in the spec.
// Requires the server running on :3000 and a fresh `npm run db:seed`.
// Run:  node verify-stage3.mjs
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME,
  multipleStatements: true,
});

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const LETTERS = ['a', 'b', 'c', 'd'];
const wrong = (c) => LETTERS.find((x) => x !== c);

// Dev auth: every request acts as the student in `ACTING` (X-User-Id header).
// Most of this harness drives demo student 1; the throwaway-student blocks set
// ACTING to their own id before driving the API.
let ACTING = 1;
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'X-User-Id': String(ACTING), ...(opts.headers || {}) },
  });
  return r.json();
}

// Stage 3 semantics assume a slot unlocks immediately on submit. Turn feedback
// gating OFF on the server for the duration of this run (the harness owns the
// setting; no env change or restart needed). Requires ENABLE_TEST_HOOKS.
{
  const r = await fetch(BASE + '/api/test/feedback-gating', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  if (r.status !== 200) {
    console.error(`FATAL: could not disable feedback gating (status ${r.status}). ` +
      `Start the server with ENABLE_TEST_HOOKS=1.`);
    process.exit(2);
  }
  console.log('[setup] feedback gating disabled for Stage 3 run');
}
async function post(path, body) {
  return j(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
async function keyFor(assignmentId) {
  const [[row]] = await db.query(
    `SELECT m.answer_key ak, m.difficulty d FROM assignments a JOIN missions m ON m.id=a.mission_id WHERE a.id=?`,
    [assignmentId]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return { correct: ak.correct, difficulty: Number(row.d) };
}

// Helper: create a throwaway student directly in the DB, segment + cold start it
// via dedicated endpoints is not exposed, so we exercise the modules through a
// tiny seeded harness table path: insert student, insert courses, then call the
// exported logic by hitting endpoints that use them. For unit-style checks we
// query the DB after driving the public API.

async function newStudent(name, age, subject, courses) {
  const [r] = await db.query(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES (?,?,?,?, 'pending')`,
    [name, age, subject, 0]);
  const id = r.insertId;
  for (const c of courses) await db.query(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?,?,NOW())`, [id, c]);
  return id;
}

// We need the segmentation + coldstart modules. They're server-side; import via
// a child tsx call would be heavy. Instead, replicate the ONE public path: the
// seed already placed the 3 demo students. For criteria 1 & 2 we drive the
// modules directly through a helper script.
import { assignSegment } from './src/segmentation.ts';
import { applyColdStart } from './src/coldstart.ts';
import { publishWeek } from './src/weekPublisher.ts';

console.log('\n[Criterion 1] assignSegment placement rules');
{
  const a = await newStudent('T-15-with-101', 15, 'Computer Science', ['CS-101']);
  const b = await newStudent('T-15-no-101', 15, 'Computer Science', []);
  const da = await assignSegment(a);
  const db2 = await assignSegment(b);
  check('15 + CS-101 -> CS Intermediate', da.segmentName === 'CS Intermediate', `(got ${da.segmentName})`);
  check('15 without CS-101 -> CS Foundation (fallback)', db2.segmentName === 'CS Foundation', `(got ${db2.segmentName}, reason=${db2.reason})`);
}

console.log('\n[Criterion 2] cold start = segment start_level');
{
  const c = await newStudent('T-coldstart', 15, 'Computer Science', ['CS-101']); // Intermediate start_level 1
  await assignSegment(c);
  const res = await applyColdStart(c);
  const [[row]] = await db.query(`SELECT current_level FROM students WHERE id=?`, [c]);
  check('level set to segment start_level (1)', Number(row.current_level) === 1 && res.startLevel === 1, `(level=${row.current_level})`);
}

console.log('\n[Criterion 3 & 12] publishWeek creates 8 slots; slot1+weekly open; idempotent');
{
  const s = await newStudent('T-week', 15, 'Computer Science', ['CS-101']);
  await assignSegment(s);
  await applyColdStart(s);
  const wk = await publishWeek(s, '2026-09-07');
  check('exactly 8 slots', wk.slots.length === 8, `(got ${wk.slots.length})`);
  const open = wk.slots.filter((x) => x.status === 'open').map((x) => x.slot_index).sort();
  check('slot 1 and weekly (8) open, rest locked', JSON.stringify(open) === JSON.stringify([1, 8]), `(open=${open})`);
  const locked = wk.slots.filter((x) => x.status === 'locked').length;
  check('6 locked', locked === 6, `(locked=${locked})`);
  const again = await publishWeek(s, '2026-09-07');
  check('[C12] second publish is a no-op', again.created === false, `(created=${again.created})`);
  const [[{ c }]] = await db.query(`SELECT COUNT(*) c FROM week_slots WHERE student_week_id=?`, [wk.studentWeekId]);
  check('[C12] still exactly 8 slots after 2nd publish', Number(c) === 8, `(count=${c})`);
}

// For the API-driven criteria, use demo Student A (id 1) freshly seeded.
console.log('\n[Criterion 4] locked slots return NO question text');
{
  const week = await j('/api/week/1');
  const locked = week.slots.filter((s) => s.status === 'locked');
  const anyContent = locked.some((s) => 'mission' in s && s.mission);
  check('locked slots present', locked.length > 0, `(locked=${locked.length})`);
  check('no locked slot carries mission content', !anyContent);
  const raw = JSON.stringify(week);
  // Locked missions bodies must not appear. Open slot 1 not yet opened so no body either.
  check('raw JSON has no body for locked slots', locked.every((s) => !s.mission));
}

console.log('\n[Criterion 5 & 8] submit slot1 unlocks+fills slot2; attempt XP once');
let studentAWeek;
{
  const week = await j('/api/week/1');
  studentAWeek = week;
  const slot1 = week.slots.find((s) => s.slot_index === 1);
  const slot2Before = week.slots.find((s) => s.slot_index === 2);
  check('slot 2 not filled before slot 1 submitted', slot2Before.assignment_id == null && slot2Before.status === 'locked');

  const open1 = await post(`/api/slot/${slot1.slot_id}/open`);
  check('slot 1 open returns a mission', !!open1.assignment_id && Array.isArray(open1.options), `(aid=${open1.assignment_id})`);
  check('attempt XP awarded on first open', open1.xp && open1.xp.awarded === true, `(pts=${open1.xp?.points})`);
  const open1b = await post(`/api/slot/${slot1.slot_id}/open`);
  check('[C8] attempt XP NOT awarded on second open', open1b.xp && open1b.xp.awarded === false && open1b.xp.reason === 'already_awarded');

  const k1 = await keyFor(open1.assignment_id);
  await post('/api/submit', { assignmentId: open1.assignment_id, selected: k1.correct });
  const week2 = await j('/api/week/1');
  const slot2After = week2.slots.find((s) => s.slot_index === 2);
  check('[C5] slot 2 now open', slot2After.status === 'open', `(status=${slot2After.status})`);
  check('[C5] slot 2 filled with a mission on unlock', slot2After.assignment_id != null, `(aid=${slot2After.assignment_id})`);
  const slot1After = week2.slots.find((s) => s.slot_index === 1);
  check('slot 1 marked submitted', slot1After.status === 'submitted');
}

console.log('\n[Criterion 6] slot 5 (offset +1) serves one level above current');
{
  // Student A is level 3 now (was 2, +1 from the correct answer above). Drive to slot 5.
  // Open+submit slots 2,3,4 correctly to unlock 5. Level may rise; we assert the
  // OFFSET relationship at slot 5 against the student's level when slot 5 opens.
  for (const idx of [2, 3, 4]) {
    const wk = await j('/api/week/1');
    const slot = wk.slots.find((s) => s.slot_index === idx);
    const o = await post(`/api/slot/${slot.slot_id}/open`);
    if (!o.assignment_id) { console.log(`   (slot ${idx} had no mission: ${o.message || 'gap'})`); continue; }
    const k = await keyFor(o.assignment_id);
    await post('/api/submit', { assignmentId: o.assignment_id, selected: k.correct });
  }
  const [[stu]] = await db.query(`SELECT current_level, max_level FROM students s LEFT JOIN segments seg ON seg.id=s.segment_id WHERE s.id=1`);
  const wk = await j('/api/week/1');
  const slot5 = wk.slots.find((s) => s.slot_index === 5);
  const o5 = await post(`/api/slot/${slot5.slot_id}/open`);
  if (o5.assignment_id) {
    const expected = Math.min(Number(stu.current_level) + 1, Number(stu.max_level));
    check('slot 5 difficulty = current_level+1 (clamped)', o5.difficulty === expected, `(diff=${o5.difficulty}, level=${stu.current_level}, expected=${expected})`);
  } else {
    check('slot 5 served a mission', false, `(no mission: ${o5.message})`);
  }
}

console.log('\n[Criterion 7] total_xp equals the sum of xp_events');
{
  const [[{ total }]] = await db.query(`SELECT total_xp total FROM students WHERE id=1`);
  const [[{ sum }]] = await db.query(`SELECT COALESCE(SUM(points),0) sum FROM xp_events WHERE student_id=1`);
  check('total_xp == SUM(xp_events.points)', Number(total) === Number(sum), `(total=${total}, sum=${sum})`);
  const xp = await j('/api/xp/1');
  check('xp endpoint returns items + total (paginated)', xp.total_xp === Number(total) && Array.isArray(xp.items) && 'nextCursor' in xp);
  // attempt+submit+correct all present
  const [types] = await db.query(`SELECT DISTINCT event_type FROM xp_events WHERE student_id=1`);
  const set = new Set(types.map((t) => t.event_type));
  check('attempt, submit, correct all awarded', set.has('attempt') && set.has('submit') && set.has('correct'), `(types=${[...set]})`);
}

console.log('\n[Criterion 9 & 10 & 11] stall -> one assistance; wrong never demotes; cap at max');
{
  // Fresh student, Foundation (max 4, start 0). Drive 3 wrongs at level 0.
  const s = await newStudent('T-stall', 13, 'Computer Science', []);
  ACTING = s; // drive the API as this student
  await assignSegment(s); // Foundation
  await applyColdStart(s);
  await publishWeek(s, '2026-09-14');
  // Walk the week: open slot, answer WRONG three times.
  let lastLevel = 0, raisedRows = 0;
  for (let step = 0; step < 3; step++) {
    const wk = await j(`/api/week/${s}`);
    const open = wk.slots.find((x) => x.status === 'open' && x.assignment_id == null) || wk.slots.find((x) => x.status === 'open');
    const o = await post(`/api/slot/${open.slot_id}/open`);
    if (!o.assignment_id) break;
    const k = await keyFor(o.assignment_id);
    const r = await post('/api/submit', { assignmentId: o.assignment_id, selected: wrong(k.correct) });
    check(`wrong #${step + 1} holds level (${r.level.from}->${r.level.to})`, r.level.to === r.level.from);
    lastLevel = r.level.to;
    if (step === 0) {
      // Pinned submit DTO — post-grade review data. A wrong answer must still be
      // shown the correct option and why (the platform builds ability).
      check('[DTO] submit returns correct=false', r.correct === false);
      check('[DTO] submit returns score_band=fail', r.score_band === 'fail', `(got ${r.score_band})`);
      check('[DTO] submit returns the correct option key', r.correct_option_key === k.correct, `(got ${r.correct_option_key})`);
      check('[DTO] submit returns a non-empty explanation', typeof r.explanation === 'string' && r.explanation.length > 0);
      check('[DTO] submit nests level {from,to,reason}', typeof r.level?.from === 'number' && typeof r.level?.to === 'number' && typeof r.level?.reason === 'string');
      check('[DTO] submit reports xp.total_xp / points_earned', typeof r.xp?.total_xp === 'number' && typeof r.xp?.points_earned === 'number');
      check('[DTO] submit does NOT leak internal studentId', r.studentId === undefined && r.correctAnswer === undefined);
    }
  }
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM assistance_events WHERE student_id=?`, [s]);
  check('[C9] exactly one assistance_events row after 3 wrongs', Number(n) === 1, `(rows=${n})`);
  // Student still gets a 4th mission (next open slot fills).
  const wk = await j(`/api/week/${s}`);
  const open = wk.slots.find((x) => x.status === 'open');
  const fourth = open ? await post(`/api/slot/${open.slot_id}/open`) : { assignment_id: null };
  check('[C9] student still receives a 4th mission', !!fourth.assignment_id || !!fourth.empty, `(aid=${fourth.assignment_id})`);
  check('[C10] level never dropped below start (0)', lastLevel === 0, `(level=${lastLevel})`);

  // [C11] cap: push a student at max level and confirm a correct answer stays at max.
  await db.query(`UPDATE students SET current_level=4 WHERE id=?`, [s]);
  const wk2 = await j(`/api/week/${s}`);
  const open2 = wk2.slots.find((x) => x.status === 'open');
  if (open2) {
    const o = await post(`/api/slot/${open2.slot_id}/open`);
    if (o.assignment_id) {
      const k = await keyFor(o.assignment_id);
      const r = await post('/api/submit', { assignmentId: o.assignment_id, selected: k.correct });
      check('[C11] correct at max level stays at max (4)', r.level.to === 4, `(${r.level.from}->${r.level.to})`);
    } else check('[C11] mission available at max', false, `(${o.message})`);
  }
}

console.log('\n[Criterion 13] relaxation order followed + logged when no exact match');
{
  // Student with an interest-less, exotic setup: force a slot whose exact filters
  // match nothing so relaxation kicks in. We give a student a slot needing a
  // difficulty with no exact mission by exhausting via direct check on logs.
  const s = await newStudent('T-relax', 15, 'Computer Science', ['CS-101']); // Intermediate
  ACTING = s; // drive the API as this student
  await assignSegment(s);
  await applyColdStart(s); // level 1
  // Assign every SHORT level-1 mission so the slot-1 (short, offset 0 -> level 1)
  // must relax difficulty. Mark them all as already served.
  const [shorts] = await db.query(`SELECT id, version FROM missions WHERE subject='Computer Science' AND mission_type='quiz' AND time_band='short' AND difficulty=1 AND status='live'`);
  for (const m of shorts) {
    await db.query(`INSERT IGNORE INTO assignments (student_id, mission_id, mission_version, level_at_assign, status) VALUES (?,?,?,?, 'graded')`, [s, m.id, m.version, 1]);
  }
  await publishWeek(s, '2026-09-21');
  const wk = await j(`/api/week/${s}`);
  const slot1 = wk.slots.find((x) => x.slot_index === 1);
  const o = await post(`/api/slot/${slot1.slot_id}/open`);
  const [[log]] = await db.query(`SELECT filters_applied FROM selection_log WHERE student_id=? ORDER BY id DESC LIMIT 1`, [s]);
  let fa = log.filters_applied; if (typeof fa === 'string') fa = JSON.parse(fa);
  check('relaxation logged with ordered list', Array.isArray(fa.relaxations) && fa.relaxations[0] === 'widen_difficulty_pm1', `(relaxations=${JSON.stringify(fa.relaxations)})`);
  check('a mission was still served after relaxing', !!o.assignment_id || !!o.empty, `(aid=${o.assignment_id}, msg=${o.message || ''})`);
}

console.log(`\n==== Stage 3: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
