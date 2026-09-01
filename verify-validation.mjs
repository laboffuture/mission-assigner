// Item 3 (input validation) acceptance harness.
// Requires the server running on :3000 with a fresh seed. Run: npm run verify:validation
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME,
});
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const STUDENT = 1;
const H = { 'X-User-Id': String(STUDENT) };
async function req(path, { method = 'GET', body = null } = {}) {
  const headers = { ...H };
  if (body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function attemptCount(aid) {
  const [[{ n }]] = await db.query(`SELECT COUNT(*) n FROM attempt_logs WHERE assignment_id=?`, [aid]);
  return Number(n);
}
async function assignmentStatus(aid) {
  const [[row]] = await db.query(`SELECT status FROM assignments WHERE id=?`, [aid]);
  return row ? row.status : null;
}
async function answerKey(aid) {
  const [[row]] = await db.query(`SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id=a.mission_id WHERE a.id=?`, [aid]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return ak.correct;
}

// Open slot 1 for student 1 to get a live OPEN assignment.
const week = await req(`/api/week/${STUDENT}`);
const slot1 = week.body.slots.find((s) => s.slot_index === 1);
const open = await req(`/api/slot/${slot1.slot_id}/open`, { method: 'POST' });
const A = open.body.assignment_id;
console.log(`\n[setup] opened slot 1 -> assignment ${A} (status ${await assignmentStatus(A)})`);

console.log('\n[A malformed body is rejected BEFORE any business logic / DB write]');
{
  const before = await attemptCount(A);
  const r = await req('/api/submit', { method: 'POST', body: { assignmentId: A, selected: 12345 } }); // selected must be a string
  check('malformed submit -> 400', r.status === 400, `(got ${r.status})`);
  check('error code is validation_error', r.body?.error?.code === 'validation_error', `(code=${r.body?.error?.code})`);
  check('error carries a requestId', typeof r.body?.error?.requestId === 'string' && r.body.error.requestId.length > 0);
  check('assignment NOT graded (business logic never ran)', (await assignmentStatus(A)) === 'open', `(status=${await assignmentStatus(A)})`);
  check('no attempt_logs row created', (await attemptCount(A)) === before, `(before=${before}, after=${await attemptCount(A)})`);
}

console.log('\n[Field-level errors name the offending field]');
{
  const r = await req('/api/submit', { method: 'POST', body: { assignmentId: A, selected: 999 } });
  const fields = r.body?.error?.fields ?? [];
  check('fields list present', Array.isArray(fields) && fields.length > 0, `(fields=${JSON.stringify(fields)})`);
  check("offending field named 'selected'", fields.some((f) => f.field === 'selected'), `(fields=${JSON.stringify(fields)})`);

  // A malformed PARAM is also caught (studentId must be a positive int).
  const p = await req('/api/progress/not-a-number');
  check('bad path param -> 400 validation_error', p.status === 400 && p.body?.error?.code === 'validation_error', `(status=${p.status})`);
  check("param field named 'studentId'", (p.body?.error?.fields ?? []).some((f) => f.field === 'studentId'));
}

console.log('\n[A valid body still passes end to end]');
{
  const correct = await answerKey(A);
  const r = await req('/api/submit', { method: 'POST', body: { assignmentId: A, selected: correct } });
  check('valid submit -> 200', r.status === 200, `(got ${r.status})`);
  check('graded correct', r.body?.correct === true, `(correct=${r.body?.correct})`);
  check('assignment now graded', (await assignmentStatus(A)) === 'graded');
}

console.log(`\n==== Validation: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
