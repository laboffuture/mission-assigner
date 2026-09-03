// Instructor assistance queue harness.
// Fabricates open assistance_events (with real failed assignments as context)
// and exercises the queue API: paginated oldest-first list, detail expansion,
// role gating, acknowledge, and resolve-with-required-note.
// Requires the server on :3000 (ENABLE_TEST_HOOKS not needed) + a fresh seed.
// Run: npm run verify:assistance
import 'dotenv/config';
import mysql from 'mysql2/promise';

const BASE = 'http://localhost:3000';
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
async function staffLogin(username) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  return cookieOf(r);
}
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

// ---- Fabricate: N failed graded assignments for a student, then an open event.
async function failedAssignments(studentId, n) {
  const [missions] = await db.query(`SELECT id, version, answer_key FROM missions ORDER BY id LIMIT ?`, [n]);
  const refs = [];
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    let key = m.answer_key; if (typeof key === 'string') key = JSON.parse(key);
    const wrong = ['a', 'b', 'c', 'd'].find((k) => k !== key.correct);
    const [tagRows] = await db.query(`SELECT tag FROM mission_tags WHERE mission_id = ?`, [m.id]);
    const [r] = await db.query(
      `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, score_band, score_pct, response, submitted_at, graded_at)
       VALUES (?,?,?,0,'graded','fail',0, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE), UTC_TIMESTAMP())`,
      [studentId, m.id, m.version, JSON.stringify({ selected: wrong }), (n - i) * 5]
    );
    refs.push({ assignment_id: r.insertId, mission_id: m.id, selected: wrong, tags: tagRows.map((t) => t.tag) });
  }
  return refs;
}
async function raiseEvent(studentId, minutesAgo) {
  const refs = await failedAssignments(studentId, 3);
  const tags = [...new Set(refs.flatMap((f) => f.tags))];
  const ctx = { failed_assignments: refs, tags_involved: tags };
  const [r] = await db.query(
    `INSERT INTO assistance_events (student_id, trigger_reason, level_at_trigger, context, status, created_at)
     VALUES (?, 'stall_threshold', 0, ?, 'open', DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`,
    [studentId, JSON.stringify(ctx), minutesAgo]
  );
  return r.insertId;
}

// Two events: student 3 raised 3 days ago (oldest), student 1 raised 1 hour ago.
const oldEventId = await raiseEvent(3, 3 * 24 * 60);
const newEventId = await raiseEvent(1, 60);

const instructor = await staffLogin('instructor');
const admin = await staffLogin('admin');

// ---------------------------------------------------------------------------
console.log('\n[Role gating: instructor/admin only]');
{
  check('unauth GET /api/assistance -> 401', (await fetch(`${BASE}/api/assistance`)).status === 401);
  const student = await devLogin(2);
  check('student -> 403', (await fetch(`${BASE}/api/assistance`, { headers: { Cookie: student } })).status === 403);
  const sme = await staffLogin('sme');
  check('sme -> 403', (await fetch(`${BASE}/api/assistance`, { headers: { Cookie: sme } })).status === 403);
  check('instructor -> 200', (await fetch(`${BASE}/api/assistance`, { headers: { Cookie: instructor } })).status === 200);
}

// ---------------------------------------------------------------------------
console.log('\n[List: open events, oldest first, { items, nextCursor }]');
{
  const { body } = await j(await fetch(`${BASE}/api/assistance`, { headers: { Cookie: instructor } }));
  check('has items[] and nextCursor key', Array.isArray(body.items) && 'nextCursor' in body);
  check('both open events present', body.items.length === 2, `(n=${body.items.length})`);
  check('oldest first (3-day wait leads)', body.items[0].id === oldEventId, `(first=${body.items[0].id})`);
  const first = body.items[0];
  check('item has student name', first.student_name === 'Rohan Verma', `(${first.student_name})`);
  check('item has current level + segment', typeof first.current_level === 'number' && first.segment_name === 'CS Foundation');
  check('item has waiting_seconds (~3 days)', first.waiting_seconds >= 3 * 24 * 3600 - 120, `(${first.waiting_seconds})`);
  check('item carries tags_involved', Array.isArray(first.tags_involved));
  check('item has created_at', typeof first.created_at === 'string');
}

// ---------------------------------------------------------------------------
console.log('\n[Pagination: limit=1 pages via nextCursor]');
{
  const p1 = (await j(await fetch(`${BASE}/api/assistance?limit=1`, { headers: { Cookie: instructor } }))).body;
  check('page1: 1 item + a cursor', p1.items.length === 1 && !!p1.nextCursor, `(n=${p1.items.length})`);
  check('page1 is the oldest event', p1.items[0].id === oldEventId);
  const p2 = (await j(await fetch(`${BASE}/api/assistance?limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`, { headers: { Cookie: instructor } }))).body;
  check('page2: the newer event, cursor null', p2.items[0].id === newEventId && p2.nextCursor === null);
}

// ---------------------------------------------------------------------------
console.log('\n[Detail: full intervention context]');
{
  const { status, body } = await j(await fetch(`${BASE}/api/assistance/${oldEventId}`, { headers: { Cookie: instructor } }));
  check('GET detail -> 200', status === 200);
  check('3 failed missions expanded', body.failed_missions.length === 3, `(n=${body.failed_missions?.length})`);
  const fm = body.failed_missions[0];
  check('failed mission has question body + options', typeof fm.body === 'string' && fm.options.length === 4);
  check('shows student answer + correct key', fm.selected_key != null && fm.correct_key.length === 1);
  check('student answer was wrong (selected != correct)', fm.selected_key !== fm.correct_key);
  check('correct answer differs and has text', fm.correct_text != null);
  check('carries the explanation', typeof fm.explanation === 'string' && fm.explanation.length > 0);
  check('has score_band fail', fm.score_band === 'fail', `(${fm.score_band})`);
  check('has tags array', Array.isArray(fm.tags));
  check('includes level_history', Array.isArray(body.level_history));
  check('unknown id -> 404', (await fetch(`${BASE}/api/assistance/999999`, { headers: { Cookie: instructor } })).status === 404);
}

// ---------------------------------------------------------------------------
console.log('\n[Acknowledge]');
{
  const { status, body } = await j(await fetch(`${BASE}/api/assistance/${newEventId}/acknowledge`, { method: 'POST', headers: { Cookie: instructor } }));
  check('acknowledge -> 200', status === 200);
  check('status now acknowledged', body.status === 'acknowledged', `(${body.status})`);
  check('acknowledged_at is set', body.acknowledged_at != null);
  // Acknowledged events drop out of the OPEN list.
  const list = (await j(await fetch(`${BASE}/api/assistance`, { headers: { Cookie: instructor } }))).body;
  check('acknowledged event left the open list', !list.items.some((e) => e.id === newEventId));
}

// ---------------------------------------------------------------------------
console.log('\n[Resolve requires a note]');
{
  const noNote = await fetch(`${BASE}/api/assistance/${oldEventId}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: instructor }, body: JSON.stringify({}),
  });
  check('resolve without note -> 400', noNote.status === 400, `(got ${noNote.status})`);
  const blank = await fetch(`${BASE}/api/assistance/${oldEventId}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: instructor }, body: JSON.stringify({ note: '   ' }),
  });
  check('resolve with blank note -> 400', blank.status === 400, `(got ${blank.status})`);

  const ok = await j(await fetch(`${BASE}/api/assistance/${oldEventId}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin },
    body: JSON.stringify({ note: 'Called the student; re-explained loops and set an easier warm-up.' }),
  }));
  check('resolve with note -> 200', ok.status === 200);
  check('status now resolved', ok.body.status === 'resolved', `(${ok.body.status})`);
  check('resolution_note stored', /re-explained loops/.test(ok.body.resolution_note ?? ''));
  check('resolved event left the open list', !(await j(await fetch(`${BASE}/api/assistance`, { headers: { Cookie: instructor } }))).body.items.some((e) => e.id === oldEventId));
  // resolved_by recorded in the DB.
  const [[row]] = await db.query(`SELECT resolved_by FROM assistance_events WHERE id = ?`, [oldEventId]);
  check('resolved_by recorded', Number(row.resolved_by) === 7, `(by=${row.resolved_by})`);

  // Re-resolving a resolved event is a conflict.
  const again = await fetch(`${BASE}/api/assistance/${oldEventId}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: JSON.stringify({ note: 'again' }),
  });
  check('re-resolve -> 409', again.status === 409, `(got ${again.status})`);
}

await db.end();
console.log(`\n==== Assistance: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
