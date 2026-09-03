// API surface adjustments harness — covers the pre-scaffold API work:
//   1. POST /api/dev/login-as sets the real session cookie (dev only).
//   2. List endpoints return a uniform { items: [...] } envelope.
// Requires the server on :3000 (AUTH_MODE=dev) with a fresh seed, and
// ENABLE_TEST_HOOKS is irrelevant here. Run: npm run verify:api-shape
import 'dotenv/config';

const BASE = 'http://localhost:3000';
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}
function cookieHeader(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((c) => c.split(';')[0]).join('; ');
}
const isArr = (x) => Array.isArray(x);
const isItems = (b) => b && isArr(b.items);

// ---------------------------------------------------------------------------
console.log('\n[Uniform list envelope: dev/users returns { items }]');
let firstStudentId = null;
{
  const res = await fetch(`${BASE}/api/dev/users`);
  const body = await res.json();
  check('GET /api/dev/users -> { items: [...] }', isItems(body), `(keys=${Object.keys(body)})`);
  check('items are not a bare array response', !isArr(body));
  const student = (body.items ?? []).find((u) => u.role === 'student');
  firstStudentId = student?.id ?? null;
  check('a student exists in the roster', firstStudentId != null);
}

// ---------------------------------------------------------------------------
console.log('\n[POST /api/dev/login-as sets a real session cookie]');
let studentCookie = '';
{
  const bad = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  check('missing studentId -> 400', bad.status === 400, `(got ${bad.status})`);

  const missing = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 999999 }),
  });
  check('unknown user -> 404', missing.status === 404, `(got ${missing.status})`);

  const res = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: firstStudentId }),
  });
  studentCookie = cookieHeader(res);
  const body = await res.json();
  check('login-as student -> 200', res.status === 200, `(got ${res.status})`);
  check('login-as sets an mh_session cookie', /mh_session=/.test(studentCookie));
  check('login-as returns the student identity', body.id === firstStudentId && body.role === 'student');
}

// ---------------------------------------------------------------------------
console.log('\n[The session cookie authenticates the student (same path LTI will use)]');
{
  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: studentCookie } });
  const body = await me.json();
  check('GET /api/me with cookie -> 200', me.status === 200, `(got ${me.status})`);
  check('/api/me resolves the student', body.id === firstStudentId && body.role === 'student');

  // Student-facing list endpoints return { items } too.
  const hist = await fetch(`${BASE}/api/history/${firstStudentId}`, { headers: { Cookie: studentCookie } });
  check('GET /api/history/:id -> { items }', isItems(await hist.json()));

  const q = await fetch(`${BASE}/api/feedback/questions`, { headers: { Cookie: studentCookie } });
  const qb = await q.json();
  check('GET /api/feedback/questions -> { items }', isItems(qb));
  check('feedback questions still carry the 5 keys', (qb.items ?? []).length === 5, `(got ${qb.items?.length})`);

  // The week board needs is_weekly to render the weekly mission outside the
  // daily sequence.
  const wk = await (await fetch(`${BASE}/api/week/${firstStudentId}`, { headers: { Cookie: studentCookie } })).json();
  check('GET /api/week has slots', isArr(wk.slots) && wk.slots.length > 0, `(slots=${wk.slots?.length})`);
  check('every slot carries a boolean is_weekly', (wk.slots ?? []).every((s) => typeof s.is_weekly === 'boolean'));
  check('exactly one weekly slot in the week', (wk.slots ?? []).filter((s) => s.is_weekly).length === 1);
  const lockedWithContent = (wk.slots ?? []).filter((s) => s.status === 'locked' && s.mission != null);
  check('locked slots never carry mission content', lockedWithContent.length === 0, `(offenders=${lockedWithContent.length})`);
}

// ---------------------------------------------------------------------------
console.log('\n[Staff list endpoints return { items } too]');
{
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW }),
  });
  const adminCookie = cookieHeader(login);
  check('admin login -> 200', login.status === 200, `(got ${login.status})`);

  const students = await fetch(`${BASE}/api/students`, { headers: { Cookie: adminCookie } });
  check('GET /api/students -> { items }', isItems(await students.json()));

  const assist = await fetch(`${BASE}/api/assistance`, { headers: { Cookie: adminCookie } });
  check('GET /api/assistance -> { items }', isItems(await assist.json()));
}

console.log(`\n==== API shape: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
