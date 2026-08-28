// Temporary end-to-end acceptance harness (not part of the deliverable).
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASS, database: process.env.DB_NAME,
});

const LETTERS = ['a', 'b', 'c', 'd'];
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  (cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
        : (fail++, console.log(`  FAIL ${name} ${detail}`)));
}

async function current(sid) {
  return (await fetch(`${BASE}/api/current/${sid}`)).json();
}
async function submit(aid, sel) {
  return (await fetch(`${BASE}/api/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignmentId: aid, selected: sel }),
  })).json();
}
async function keyFor(aid) {
  const [[row]] = await db.query(
    `SELECT m.answer_key ak, a.mission_id mid
       FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`, [aid]);
  let ak = row.ak; if (typeof ak === 'string') ak = JSON.parse(ak);
  return { correct: ak.correct, missionId: Number(row.mid) };
}
const wrong = (c) => LETTERS.find((x) => x !== c);

const seen = { 1: new Set(), 2: new Set(), 3: new Set() };
function track(sid, mid) { seen[sid].add(mid); }

// ---- Criterion 4: Student B correct → 3->4 pass_level_up ------------------
console.log('\n[Criterion 4] Student B answers correctly');
{
  const c = await current(2); track(2, (await keyFor(c.assignment_id)).missionId);
  check('served at level 3', c.difficulty === 3, `(difficulty=${c.difficulty})`);
  const k = await keyFor(c.assignment_id);
  const r = await submit(c.assignment_id, k.correct);
  check('correct=true', r.correct === true);
  check('3 -> 4', r.fromLevel === 3 && r.toLevel === 4, `(${r.fromLevel}->${r.toLevel})`);
  check("reason pass_level_up", r.reason === 'pass_level_up', `(${r.reason})`);
  // Criterion 9: next mission at new level
  const n = await current(2); track(2, (await keyFor(n.assignment_id)).missionId);
  check('[C9] next mission at level 4', n.difficulty === 4, `(difficulty=${n.difficulty})`);
}

// ---- Criterion 5: Student A wrong -> stays, wrong again -> still stays -----
// Learning platform: a wrong answer NEVER demotes. It holds the level and
// serves another question at the same level.
console.log('\n[Criterion 5] Student A fails twice (never demotes)');
{
  const c1 = await current(1); const k1 = await keyFor(c1.assignment_id); track(1, k1.missionId);
  check('served at level 2', c1.difficulty === 2, `(difficulty=${c1.difficulty})`);
  const r1 = await submit(c1.assignment_id, wrong(k1.correct));
  check('first fail holds 2 -> 2', r1.fromLevel === 2 && r1.toLevel === 2, `(${r1.fromLevel}->${r1.toLevel})`);
  check('reason wrong_retry_same_level', r1.reason === 'wrong_retry_same_level', `(${r1.reason})`);
  const c2 = await current(1); const k2 = await keyFor(c2.assignment_id); track(1, k2.missionId);
  check('[C9] still level 2 after first miss', c2.difficulty === 2, `(difficulty=${c2.difficulty})`);
  const r2 = await submit(c2.assignment_id, wrong(k2.correct));
  check('second fail STILL holds 2 -> 2 (no demotion)', r2.fromLevel === 2 && r2.toLevel === 2, `(${r2.fromLevel}->${r2.toLevel})`);
  check('reason wrong_retry_same_level', r2.reason === 'wrong_retry_same_level', `(${r2.reason})`);
  const c3 = await current(1); track(1, (await keyFor(c3.assignment_id)).missionId);
  check('[C9] next mission STILL at level 2', c3.difficulty === 2, `(difficulty=${c3.difficulty})`);
}

// ---- Criterion 6: Student C at level 0 stays put on wrong answers ----------
console.log('\n[Criterion 6] Student C fails twice at level 0 (stays at 0)');
{
  const c1 = await current(3); const k1 = await keyFor(c1.assignment_id); track(3, k1.missionId);
  check('served at level 0', c1.difficulty === 0, `(difficulty=${c1.difficulty})`);
  const r1 = await submit(c1.assignment_id, wrong(k1.correct));
  check('first fail holds 0 -> 0', r1.fromLevel === 0 && r1.toLevel === 0, `(${r1.fromLevel}->${r1.toLevel})`);
  const c2 = await current(3); const k2 = await keyFor(c2.assignment_id); track(3, k2.missionId);
  const r2 = await submit(c2.assignment_id, wrong(k2.correct));
  check('second fail stays 0 (never negative)', r2.toLevel === 0, `(${r2.fromLevel}->${r2.toLevel}, reason=${r2.reason})`);
}

// ---- Criterion 7: no repeated missions -----------------------------------
console.log('\n[Criterion 7] No mission served twice per student');
for (const sid of [1, 2, 3]) {
  const [rows] = await db.query(
    `SELECT mission_id, COUNT(*) c FROM assignments WHERE student_id = ? GROUP BY mission_id HAVING c > 1`, [sid]);
  check(`student ${sid} has no duplicate assignments`, rows.length === 0, `(distinct served=${seen[sid].size})`);
}

// ---- Criterion 8: every assignment logged with candidates ----------------
console.log('\n[Criterion 8] selection_log captures candidates');
{
  const [[{ assignCount }]] = await db.query(`SELECT COUNT(*) assignCount FROM assignments`);
  const [[{ logCount }]] = await db.query(`SELECT COUNT(*) logCount FROM selection_log WHERE chosen_mission IS NOT NULL`);
  check('one selection_log row per assignment', Number(logCount) === Number(assignCount), `(assignments=${assignCount}, logs=${logCount})`);
  const [[sample]] = await db.query(`SELECT candidates FROM selection_log WHERE chosen_mission IS NOT NULL ORDER BY id DESC LIMIT 1`);
  let cand = sample.candidates; if (typeof cand === 'string') cand = JSON.parse(cand);
  check('candidate list is non-empty and has overlap scores', Array.isArray(cand) && cand.length > 0 && 'overlap' in cand[0], `(candidates=${cand.length})`);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await db.end();
process.exit(fail ? 1 : 0);
