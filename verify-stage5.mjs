// Stage 5 acceptance harness — covers the 17 criteria in the spec.
// Requires the server running on :3000 and a fresh `npm run db:seed`.
// Run:  npm run verify:stage5   (tsx, because it imports .ts modules)
import 'dotenv/config';
import mysql from 'mysql2/promise';

import { assignSegment } from './src/segmentation.ts';
import { applyColdStart } from './src/coldstart.ts';
import { publishWeek } from './src/weekPublisher.ts';
import { fillSlot } from './src/slotFiller.ts';
import { submitAndGrade } from './src/grading.ts';
import { unlockNext } from './src/slotUnlock.ts';
import { getQuestions, submitFeedback, clearQuestionCache, FeedbackError } from './src/feedback.ts';
import { computeStreak } from './src/streaks.ts';
import { getMissionQuality } from './src/tracking.ts';
import { setFeedbackGatesUnlock } from './src/config.ts';

const BASE = 'http://localhost:3000';
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME, multipleStatements: true,
});

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const LETTERS = ['a', 'b', 'c', 'd'];
const wrong = (c) => LETTERS.find((x) => x !== c);

// Dev auth: default to acting as demo student 1; C14 overrides via headers.
async function j(path, opts = {}) {
  return (await fetch(BASE + path, { ...opts, headers: { 'X-User-Id': '1', ...(opts.headers || {}) } })).json();
}
async function status(path, opts = {}) {
  return (await fetch(BASE + path, { ...opts, headers: { 'X-User-Id': '1', ...(opts.headers || {}) } })).status;
}

// This harness sets feedback gating to TRUE for its own run: in-process (via the
// config setter, which governs the unlockNext calls below) and on the server
// (via the guarded test hook, which also leaves the demo in gating-on state).
setFeedbackGatesUnlock(true);
{
  const r = await fetch(BASE + '/api/test/feedback-gating', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  if (r.status !== 200) {
    console.error(`FATAL: could not enable feedback gating (status ${r.status}). ` +
      `Start the server with ENABLE_TEST_HOOKS=1.`);
    process.exit(2);
  }
  console.log('[setup] feedback gating enabled for Stage 5 run');
}

async function newStudent(name, age, courses = []) {
  const [r] = await db.query(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES (?,?,?,?, 'pending')`,
    [name, age, 'Computer Science', 0]);
  const id = r.insertId;
  for (const c of courses) await db.query(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?,?,NOW())`, [id, c]);
  await assignSegment(id);
  await applyColdStart(id);
  return id;
}
async function answerKey(aid) {
  const [[row]] = await db.query(`SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id=a.mission_id WHERE a.id=?`, [aid]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return ak.correct;
}
// Publish a week, fill + grade slot 1. Returns the assignment id and grade result.
async function gradeSlot1(sid, weekStart, correct = true, backdateOpenSeconds = 0) {
  const wk = await publishWeek(sid, weekStart);
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const fill = await fillSlot(slot1.id);
  const aid = fill.assignmentId;
  if (backdateOpenSeconds > 0) {
    await db.query(`UPDATE assignments SET opened_at = DATE_SUB(NOW(), INTERVAL ? SECOND) WHERE id=?`, [backdateOpenSeconds, aid]);
  }
  const key = await answerKey(aid);
  const res = await submitAndGrade(aid, correct ? key : wrong(key));
  return { wk, slot1, aid, res };
}
function fullValid(overrides = {}) {
  const base = { perceived_difficulty: 'About right', time_taken: 'About as expected', clarity: '4', confidence: '3' };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).map(([question_key, value]) => ({ question_key, value: String(value) }));
}
async function expectReject(fn) {
  try { await fn(); return { ok: false }; }
  catch (e) { return { ok: true, status: e.status, msg: e.message }; }
}
async function slotStatus(sid, idx) {
  const [[row]] = await db.query(
    `SELECT ws.status FROM week_slots ws JOIN student_weeks sw ON sw.id=ws.student_week_id
      WHERE sw.student_id=? AND ws.slot_index=? ORDER BY sw.id DESC LIMIT 1`, [sid, idx]);
  return row ? row.status : null;
}

// ---------------------------------------------------------------------------
console.log('\n[C1] GET /api/feedback/questions returns 5 placeholders in order');
{
  const qs = await j('/api/feedback/questions');
  check('5 questions', qs.length === 5, `(got ${qs.length})`);
  const orders = qs.map((q) => q.display_order);
  check('ordered by display_order', JSON.stringify(orders) === JSON.stringify([...orders].sort((a, b) => a - b)), `(${orders})`);
  const keys = qs.map((q) => q.question_key);
  check('expected keys present', JSON.stringify(keys) === JSON.stringify(['perceived_difficulty', 'time_taken', 'clarity', 'confidence', 'comments']), `(${keys})`);
}

console.log('\n[C2] missing required answer is rejected and NOTHING is saved');
{
  const sid = await newStudent('T5-missing', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const r = await expectReject(() => submitFeedback(aid, sid, fullValid({ clarity: undefined }).filter((a) => a.question_key !== 'clarity')));
  check('rejected (400)', r.ok && r.status === 400, `(${r.status}: ${r.msg})`);
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM feedback_responses WHERE assignment_id=?`, [aid]);
  check('no rows saved', Number(n) === 0, `(rows=${n})`);
  const [[{ fs }]] = await db.query(`SELECT feedback_status fs FROM assignments WHERE id=?`, [aid]);
  check('feedback_status not complete', fs !== 'complete', `(status=${fs})`);
}

console.log('\n[C3] scale_1_5: 6 rejected, 3 accepted');
{
  const sid = await newStudent('T5-scale', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const bad = await expectReject(() => submitFeedback(aid, sid, fullValid({ clarity: '6' })));
  check('clarity=6 rejected (400)', bad.ok && bad.status === 400, `(${bad.status})`);
  const good = await submitFeedback(aid, sid, fullValid({ clarity: '3' }));
  check('clarity=3 accepted', good.alreadyComplete === false && good.responsesSaved >= 4, `(saved=${good.responsesSaved})`);
}

console.log('\n[C4] single_select not in options is rejected');
{
  const sid = await newStudent('T5-select', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const r = await expectReject(() => submitFeedback(aid, sid, fullValid({ perceived_difficulty: 'Bananas' })));
  check('off-list value rejected (400)', r.ok && r.status === 400, `(${r.status}: ${r.msg})`);
}

console.log('\n[C5] feedback rejected before the mission is graded');
{
  const sid = await newStudent('T5-ungraded', 13);
  const wk = await publishWeek(sid, '2026-10-05');
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const fill = await fillSlot(slot1.id); // assignment exists, status 'open', NOT graded
  const r = await expectReject(() => submitFeedback(fill.assignmentId, sid, fullValid()));
  check('rejected before grading (409)', r.ok && r.status === 409, `(${r.status}: ${r.msg})`);
}

console.log('\n[C6] submitting feedback twice: no duplicate rows, no double XP');
{
  const sid = await newStudent('T5-twice', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const first = await submitFeedback(aid, sid, fullValid());
  const second = await submitFeedback(aid, sid, fullValid());
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM feedback_responses WHERE assignment_id=?`, [aid]);
  const [[{ x }]] = await db.query(`SELECT COUNT(*) x FROM xp_events WHERE assignment_id=? AND event_type='feedback'`, [aid]);
  check('first awarded XP', first.xp.awarded === true, `(pts=${first.xp.points})`);
  check('second did not award again', second.alreadyComplete === true && second.xp.awarded === false);
  check('exactly one set of responses', Number(n) === first.responsesSaved, `(rows=${n})`);
  check('exactly one feedback xp_event', Number(x) === 1, `(events=${x})`);
}

console.log('\n[C7] FEEDBACK_GATES_UNLOCK=TRUE: next slot stays locked until feedback');
let aidForC10 = null; let sidForC10 = null;
{
  setFeedbackGatesUnlock(true);
  const sid = await newStudent('T5-gate-on', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const u1 = await unlockNext(aid);
  check('gated after grading', u1.gatedOnFeedback === true && u1.openedSlotId === null);
  check('slot 2 still locked', (await slotStatus(sid, 2)) === 'locked', `(status=${await slotStatus(sid, 2)})`);
  await submitFeedback(aid, sid, fullValid());
  const u2 = await unlockNext(aid); // server does this after feedback when gating is on
  check('slot 2 opens after feedback', (await slotStatus(sid, 2)) === 'open', `(status=${await slotStatus(sid, 2)})`);
  check('unlock opened a slot', u2.openedSlotId != null);
  aidForC10 = aid; sidForC10 = sid;
}

console.log('\n[C8] FEEDBACK_GATES_UNLOCK=FALSE: matches Stage 3 (immediate unlock)');
{
  setFeedbackGatesUnlock(false);
  const sid = await newStudent('T5-gate-off', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  const u = await unlockNext(aid);
  check('not gated', u.gatedOnFeedback === false);
  check('slot 2 open immediately', (await slotStatus(sid, 2)) === 'open', `(status=${await slotStatus(sid, 2)})`);
  const [[{ fs }]] = await db.query(`SELECT feedback_status fs FROM assignments WHERE id=?`, [aid]);
  check('feedback marked not_required (optional)', fs === 'not_required', `(status=${fs})`);
  setFeedbackGatesUnlock(true);
}

console.log('\n[C9] the weekly slot is never gated');
{
  setFeedbackGatesUnlock(true);
  const sid = await newStudent('T5-weekly', 13);
  const wk = await publishWeek(sid, '2026-10-05');
  const weekly = wk.slots.find((s) => s.slot_index === 8); // is_weekly slot, opens at publish
  const fill = await fillSlot(weekly.id);
  const key = await answerKey(fill.assignmentId);
  await submitAndGrade(fill.assignmentId, key);
  const u = await unlockNext(fill.assignmentId);
  check('weekly slot not gated', u.gatedOnFeedback === false, `(gated=${u.gatedOnFeedback})`);
  const [[{ fs }]] = await db.query(`SELECT feedback_status fs FROM assignments WHERE id=?`, [fill.assignmentId]);
  check('weekly assignment feedback not_required', fs === 'not_required', `(status=${fs})`);
}

console.log('\n[C10] attempt_logs records opened, submitted, graded, feedback_submitted');
{
  const [rows] = await db.query(`SELECT DISTINCT event FROM attempt_logs WHERE assignment_id=?`, [aidForC10]);
  const events = new Set(rows.map((r) => r.event));
  for (const e of ['opened', 'submitted', 'graded', 'feedback_submitted']) {
    check(`logged '${e}'`, events.has(e), `(events=${[...events]})`);
  }
}

console.log('\n[C11] time_to_submit_seconds is computed and stored');
{
  const sid = await newStudent('T5-time', 13);
  const { aid } = await gradeSlot1(sid, '2026-10-05', true, 5); // opened 5s before submit
  const [[{ t }]] = await db.query(`SELECT time_to_submit_seconds t FROM assignments WHERE id=?`, [aid]);
  check('time_to_submit stored', t != null, `(t=${t})`);
  check('time_to_submit >= 5s (from opened_at)', Number(t) >= 5, `(t=${t})`);
}

console.log('\n[C12] computeStreak = 3 for three consecutive days, unbroken by today having none');
{
  const sid = await newStudent('T5-streak', 13);
  // Need an assignment to satisfy the attempt_logs FK.
  const { aid } = await gradeSlot1(sid, '2026-10-05');
  // Wipe the auto-created 'submitted' log so we control the dates exactly.
  await db.query(`DELETE FROM attempt_logs WHERE student_id=? AND event='submitted'`, [sid]);
  for (const nDaysAgo of [1, 2, 3]) { // yesterday, -2, -3; NOT today
    await db.query(
      `INSERT INTO attempt_logs (assignment_id, student_id, event, created_at)
       VALUES (?, ?, 'submitted', DATE_SUB(CURDATE(), INTERVAL ? DAY))`, [aid, sid, nDaysAgo]);
  }
  const streak = await computeStreak(sid);
  check('streak = 3', streak === 3, `(streak=${streak})`);
}

console.log('\n[C13] getMissionQuality flags MISMATCH (tagged 1, pass rate < 35% -> observed 4)');
{
  const [mi] = await db.query(
    `INSERT INTO missions (version, subject, title, body, mission_type, grading_mode, difficulty, age_min, age_max, time_band, answer_key, status)
     VALUES (1,'Computer Science','MISMATCH probe','body','quiz','auto',1,12,18,'short',?, 'live')`,
    [JSON.stringify({ correct: 'a' })]);
  const missionId = mi.insertId;
  for (let i = 0; i < 6; i++) {
    const [su] = await db.query(`INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES (?,13,'Computer Science',1,'complete')`, [`T5-mm-${i}`]);
    await db.query(
      `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, score_band, score_pct, submitted_at, graded_at)
       VALUES (?,?,1,1,'graded','fail',0,NOW(),NOW())`, [su.insertId, missionId]);
  }
  const [row] = await getMissionQuality(missionId);
  check('report row returned (>=5 attempts)', !!row && row.attempts >= 5, `(attempts=${row?.attempts})`);
  check('tagged difficulty 1', row?.tagged_difficulty === 1);
  check('observed difficulty 4 (pass rate 0%)', row?.observed_difficulty === 4, `(observed=${row?.observed_difficulty})`);
  check('MISMATCH flagged', row?.mismatch === true);
}

console.log('\n[C14] a student cannot read another student\'s progress or submissions');
{
  const okSelf = await status('/api/progress/1', { headers: { 'X-Student-Id': '1' } });
  const forbidden = await status('/api/progress/2', { headers: { 'X-Student-Id': '1' } });
  const forbiddenSub = await status('/api/submissions/2', { headers: { 'X-Student-Id': '1' } });
  check('own progress allowed (200)', okSelf === 200, `(${okSelf})`);
  check('other progress forbidden (403)', forbidden === 403, `(${forbidden})`);
  check('other submissions forbidden (403)', forbiddenSub === 403, `(${forbiddenSub})`);
}

console.log('\n[C15] editing a question prompt changes the UI source (getQuestions) with no code change');
{
  const [[orig]] = await db.query(`SELECT prompt FROM feedback_questions WHERE question_key='clarity'`);
  const edited = 'EDITED PROMPT — clarity check';
  await db.query(`UPDATE feedback_questions SET prompt=? WHERE question_key='clarity'`, [edited]);
  clearQuestionCache();
  const qs = await getQuestions();
  const q = qs.find((x) => x.question_key === 'clarity');
  check('getQuestions reflects the edited prompt', q && q.prompt === edited, `(prompt="${q?.prompt}")`);
  await db.query(`UPDATE feedback_questions SET prompt=? WHERE question_key='clarity'`, [orig.prompt]);
  clearQuestionCache();
}

console.log('\n[C16] retiring a question hides it from new feedback; history stays readable via question_key');
{
  // 'confidence' has historical responses from earlier submissions.
  const [[{ cbefore }]] = await db.query(`SELECT COUNT(*) cbefore FROM feedback_responses WHERE question_key='confidence'`);
  await db.query(`UPDATE feedback_questions SET active=FALSE WHERE question_key='confidence'`);
  clearQuestionCache();
  const qs = await getQuestions();
  check('retired question absent from active set', !qs.some((q) => q.question_key === 'confidence'));
  const [[{ cafter }]] = await db.query(`SELECT COUNT(*) cafter FROM feedback_responses WHERE question_key='confidence'`);
  check('historical responses still readable via question_key', Number(cafter) === Number(cbefore) && Number(cafter) > 0, `(before=${cbefore}, after=${cafter})`);
  await db.query(`UPDATE feedback_questions SET active=TRUE WHERE question_key='confidence'`);
  clearQuestionCache();
}

console.log('\n[C17] Stage 1/2/3 regressions — run the whole suite in one pass:');
console.log('   npm run verify:all   (Stage 1 + Stage 2 + Stage 3 + Stage 5; each harness injects its own gating)');

console.log(`\n==== Stage 5: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
