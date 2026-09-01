// Item 7 (timezone correctness) acceptance harness.
// Run: npm run verify:timezone  (tsx — imports .ts)
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { assignSegment } from './src/segmentation.js';
import { applyColdStart } from './src/coldstart.js';
import { publishWeek } from './src/weekPublisher.js';
import { fillSlot } from './src/slotFiller.js';
import { submitAndGrade } from './src/grading.js';
import { computeStreak } from './src/streaks.js';

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME, timezone: 'Z',
});
await db.query("SET time_zone = '+00:00'");

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
async function newStudent(name, tz, courses = []) {
  const [r] = await db.query(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status, timezone)
     VALUES (?,13,'Computer Science',0,'complete',?)`, [name, tz]);
  const id = r.insertId;
  for (const c of courses) await db.query(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?,?,NOW())`, [id, c]);
  return id;
}
async function makeAssignment(studentId) {
  const [[m]] = await db.query(`SELECT id, version FROM missions WHERE status='live' ORDER BY id LIMIT 1`);
  const [r] = await db.query(
    `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status)
     VALUES (?,?,?,0,'graded')`, [studentId, m.id, m.version]);
  return r.insertId;
}
async function answerKey(aid) {
  const [[row]] = await db.query(`SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id=a.mission_id WHERE a.id=?`, [aid]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return ak.correct;
}
// Insert a 'submitted' event at the student's LOCAL date (today - nDaysAgo) at localTime.
async function submitAtLocal(aid, sid, tz, nDaysAgo, localTime) {
  await db.query(
    `INSERT INTO attempt_logs (assignment_id, student_id, event, created_at)
     VALUES (?, ?, 'submitted',
       CONVERT_TZ(CONCAT(DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00',?)), INTERVAL ? DAY), ' ', ?), ?, '+00:00'))`,
    [aid, sid, tz, nDaysAgo, localTime, tz]);
}

console.log('\n[time_to_submit_seconds is correct regardless of server timezone (computed in SQL)]');
{
  const sid = await newStudent('TZ-time', 'Asia/Kolkata', ['CS-101']);
  await assignSegment(sid); await applyColdStart(sid);
  const wk = await publishWeek(sid, '2026-11-02');
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  const fill = await fillSlot(slot1.id);
  await db.query(`UPDATE assignments SET opened_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 SECOND) WHERE id=?`, [fill.assignmentId]);
  const res = await submitAndGrade(fill.assignmentId, await answerKey(fill.assignmentId));
  const [[{ t }]] = await db.query(`SELECT time_to_submit_seconds t FROM assignments WHERE id=?`, [fill.assignmentId]);
  check('time_to_submit ~ 7s (>=7, <60)', Number(t) >= 7 && Number(t) < 60, `(t=${t})`);
  check('grade result reports the same value', res.timeToSubmitSeconds === Number(t), `(res=${res.timeToSubmitSeconds})`);
}

console.log('\n[A student in Asia/Kolkata submitting at 23:30 local does not break their streak]');
{
  const sid = await newStudent('TZ-2330', 'Asia/Kolkata');
  const aid = await makeAssignment(sid);
  for (const n of [0, 1, 2]) await submitAtLocal(aid, sid, 'Asia/Kolkata', n, '23:30:00');
  const streak = await computeStreak(sid);
  check('streak = 3 (today 23:30 counts, not rolled to next day)', streak === 3, `(streak=${streak})`);
}

console.log('\n[The streak boundary is the student\'s midnight, not UTC midnight]');
{
  // Same UTC instants for two students in different zones. instant1 = Kolkata
  // local today 00:30 (= UTC yesterday 19:00); instant2 = Kolkata local yesterday
  // 12:00 (= UTC yesterday 06:30). In Kolkata these are two consecutive days;
  // in UTC they collapse onto a single day.
  const K = await newStudent('TZ-K', 'Asia/Kolkata');
  const U = await newStudent('TZ-U', 'UTC');
  const aidK = await makeAssignment(K);
  const aidU = await makeAssignment(U);
  const instants = [
    `CONVERT_TZ(CONCAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','Asia/Kolkata')),' 00:30:00'),'Asia/Kolkata','+00:00')`,
    `CONVERT_TZ(CONCAT(DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','Asia/Kolkata')), INTERVAL 1 DAY),' 12:00:00'),'Asia/Kolkata','+00:00')`,
  ];
  for (const expr of instants) {
    await db.query(`INSERT INTO attempt_logs (assignment_id, student_id, event, created_at) VALUES (?, ?, 'submitted', ${expr})`, [aidK, K]);
    await db.query(`INSERT INTO attempt_logs (assignment_id, student_id, event, created_at) VALUES (?, ?, 'submitted', ${expr})`, [aidU, U]);
  }
  const sK = await computeStreak(K);
  const sU = await computeStreak(U);
  check('Kolkata student: streak 2 (two consecutive LOCAL days)', sK === 2, `(sK=${sK})`);
  check('UTC student, identical UTC instants: streak 1 (one UTC day)', sU === 1, `(sU=${sU})`);
  check('streak differs by timezone -> boundary is the student midnight', sK !== sU);
}

// Cleanup throwaway students.
await db.query(`DELETE FROM students WHERE display_name LIKE 'TZ-%'`);

console.log(`\n==== Timezone: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
