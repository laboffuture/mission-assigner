// Item 1 (auth) acceptance harness.
// Requires the server running on :3000 with AUTH_MODE=dev and a fresh seed
// (which creates one user per non-student role). Run: npm run verify:auth
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

// Status-only request. `as` sets the X-User-Id header (omit for unauthenticated).
async function code(path, { method = 'GET', as = null, body = null } = {}) {
  const headers = {};
  if (as != null) headers['X-User-Id'] = String(as);
  if (body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  return r.status;
}

// Resolve one id per role from the seed.
const [[a]] = await db.query(`SELECT id FROM students WHERE role='student' ORDER BY id LIMIT 1`);
const [[b]] = await db.query(`SELECT id FROM students WHERE role='student' ORDER BY id LIMIT 1 OFFSET 1`);
const [[sme]] = await db.query(`SELECT id FROM students WHERE role='sme' LIMIT 1`);
const [[admin]] = await db.query(`SELECT id FROM students WHERE role='admin' LIMIT 1`);
const A = a.id, B = b.id, SME = sme.id, ADMIN = admin.id;

console.log(`\n[setup] student A=${A}, student B=${B}, SME=${SME}, admin=${ADMIN}`);

// Generate an assignment owned by B (so we can test A reading B's attempts).
let bAssignment = null;
{
  const wk = await (await fetch(`${BASE}/api/week/${B}`, { headers: { 'X-User-Id': String(B) } })).json();
  const slot1 = wk.slots ? wk.slots.find((s) => s.slot_index === 1) : null;
  if (slot1) {
    const open = await (await fetch(`${BASE}/api/slot/${slot1.slot_id}/open`, {
      method: 'POST', headers: { 'X-User-Id': String(B) },
    })).json();
    bAssignment = open.assignment_id ?? null;
  }
}

console.log('\n[Every endpoint rejects an unauthenticated request]');
{
  const endpoints = [
    ['GET', `/api/progress/${A}`], ['GET', `/api/submissions/${A}`], ['GET', `/api/xp/${A}`],
    ['GET', `/api/week/${A}`], ['GET', `/api/history/${A}`], ['GET', `/api/segment/${A}`],
    ['GET', `/api/current/${A}`], ['GET', '/api/feedback/questions'], ['GET', '/api/mission-quality'],
    ['GET', '/api/students'], ['GET', '/api/assistance'],
    ['POST', '/api/submit'], ['POST', '/api/slot/1/open'], ['POST', '/api/feedback/1'],
  ];
  for (const [method, p] of endpoints) {
    const s = await code(p, { method });
    check(`unauth ${method} ${p} -> 401`, s === 401, `(got ${s})`);
  }
}

console.log('\n[A student cannot read another student\'s data — 403, not empty 200]');
{
  check('A -> B progress = 403', (await code(`/api/progress/${B}`, { as: A })) === 403);
  check('A -> B submissions = 403', (await code(`/api/submissions/${B}`, { as: A })) === 403);
  check('A -> B xp = 403', (await code(`/api/xp/${B}`, { as: A })) === 403);
  check('A -> B history = 403', (await code(`/api/history/${B}`, { as: A })) === 403);
  if (bAssignment != null) {
    check('A -> B attempts = 403', (await code(`/api/attempts/${bAssignment}`, { as: A })) === 403);
    check('B -> own attempts = 200', (await code(`/api/attempts/${bAssignment}`, { as: B })) === 200);
  } else {
    check('B assignment created for attempts test', false, '(could not open B slot)');
  }
  // Sanity: A reading A's own data still works.
  check('A -> A progress = 200', (await code(`/api/progress/${A}`, { as: A })) === 200);
}

console.log('\n[A student cannot reach /quality]');
{
  check('student -> mission-quality = 403', (await code('/api/mission-quality', { as: A })) === 403);
  check('student -> /api/students (staff roster) = 403', (await code('/api/students', { as: A })) === 403);
}

console.log('\n[An SME can reach /quality but cannot submit a mission]');
{
  check('SME -> mission-quality = 200', (await code('/api/mission-quality', { as: SME })) === 200);
  const submitStatus = await code('/api/submit', { method: 'POST', as: SME, body: { assignmentId: bAssignment ?? 1, selected: 'a' } });
  check('SME -> submit = 403 (student-only)', submitStatus === 403, `(got ${submitStatus})`);
  check('admin -> /api/students (staff roster) = 200', (await code('/api/students', { as: ADMIN })) === 200);
}

console.log(`\n==== Auth: ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
