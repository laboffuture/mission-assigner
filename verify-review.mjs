// Mission review harness — GET /api/assignment/:id/review.
// A student reviews their own completed mission; ownership enforced in SQL.
// Requires the server on :3000 + a fresh seed. Run: npm run verify:review
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
async function devLogin(studentId) {
  const r = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId }),
  });
  return cookieOf(r);
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
});

// Grade a mission for student 1 through the real flow (open + submit WRONG so we
// exercise the "shown the right answer" path), and one CORRECT for student 2.
async function keyFor(missionId) {
  const [[m]] = await db.query(`SELECT answer_key FROM missions WHERE id = ?`, [missionId]);
  let k = m.answer_key; if (typeof k === 'string') k = JSON.parse(k);
  return k.correct;
}
async function completeOne(studentId, wrong) {
  const cookie = await devLogin(studentId);
  const wk = await (await fetch(`${BASE}/api/week/${studentId}`, { headers: { Cookie: cookie } })).json();
  const slot = wk.slots.find((s) => s.status === 'open');
  const opened = await (await fetch(`${BASE}/api/slot/${slot.slot_id}/open`, { method: 'POST', headers: { Cookie: cookie } })).json();
  const [[{ mission_id }]] = await db.query(`SELECT mission_id FROM assignments WHERE id = ?`, [opened.assignment_id]);
  const correct = await keyFor(mission_id);
  const pick = wrong ? ['a', 'b', 'c', 'd'].find((x) => x !== correct) : correct;
  await fetch(`${BASE}/api/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ assignmentId: opened.assignment_id, selected: pick }),
  });
  return { cookie, assignmentId: opened.assignment_id, correct, pick };
}

const s1 = await completeOne(1, true); // student 1 answered WRONG
const s2 = await completeOne(2, false); // student 2 answered CORRECT

console.log('\n[A student reviews their own completed mission]');
{
  const { status, body } = await j(await fetch(`${BASE}/api/assignment/${s1.assignmentId}/review`, { headers: { Cookie: s1.cookie } }));
  check('GET review -> 200', status === 200, `(got ${status})`);
  check('has question body + 4 options', typeof body.body === 'string' && body.options.length === 4);
  check('shows their selected answer', body.selected_key === s1.pick, `(sel=${body.selected_key})`);
  check('shows the correct key + text', body.correct_key === s1.correct && body.correct_text != null);
  check('marks it incorrect (they answered wrong)', body.correct === false && body.selected_key !== body.correct_key);
  check('carries the explanation', typeof body.explanation === 'string' && body.explanation.length > 0);
  check('has score_band + submitted_at', typeof body.score_band === 'string' && body.submitted_at != null);
}

console.log('\n[A correct answer reviews as correct]');
{
  const { body } = await j(await fetch(`${BASE}/api/assignment/${s2.assignmentId}/review`, { headers: { Cookie: s2.cookie } }));
  check('correct=true', body.correct === true);
  check('selected == correct', body.selected_key === body.correct_key);
}

console.log('\n[Ownership: a student cannot review another student\'s assignment]');
{
  const cross = await fetch(`${BASE}/api/assignment/${s2.assignmentId}/review`, { headers: { Cookie: s1.cookie } });
  check('student1 -> student2 review = 403', cross.status === 403, `(got ${cross.status})`);
  const unauth = await fetch(`${BASE}/api/assignment/${s1.assignmentId}/review`);
  check('unauthenticated -> 401', unauth.status === 401, `(got ${unauth.status})`);
}

console.log('\n[Edge cases]');
{
  const missing = await fetch(`${BASE}/api/assignment/999999/review`, { headers: { Cookie: s1.cookie } });
  check('unknown assignment -> 404', missing.status === 404, `(got ${missing.status})`);

  // An open (ungraded) assignment is not reviewable.
  const cookie3 = await devLogin(3);
  const wk = await (await fetch(`${BASE}/api/week/3`, { headers: { Cookie: cookie3 } })).json();
  const slot = wk.slots.find((s) => s.status === 'open');
  const opened = await (await fetch(`${BASE}/api/slot/${slot.slot_id}/open`, { method: 'POST', headers: { Cookie: cookie3 } })).json();
  const notGraded = await fetch(`${BASE}/api/assignment/${opened.assignment_id}/review`, { headers: { Cookie: cookie3 } });
  check('ungraded assignment -> 409', notGraded.status === 409, `(got ${notGraded.status})`);
}

await db.end();
console.log(`\n==== Review: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
