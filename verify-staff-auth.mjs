// Staff login (session cookie) acceptance harness.
// Requires the server on :3000 with a fresh seed (staff usernames sme/qc/admin,
// default password "changeme"). Run: npm run verify:staff-auth
import 'dotenv/config';

const BASE = 'http://localhost:3000';
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// Turn Set-Cookie headers into a Cookie request header (name=value pairs only).
function cookieHeader(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((c) => c.split(';')[0]).join('; ');
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, cookie: cookieHeader(res), body: await res.json().catch(() => ({})) };
}

console.log('\n[Login rejects bad credentials — generic 401]');
{
  const unknown = await login('nobody', PW);
  check('unknown username -> 401', unknown.status === 401, `(got ${unknown.status})`);
  const wrong = await login('sme', 'wrong-password');
  check('wrong password -> 401', wrong.status === 401, `(got ${wrong.status})`);
  const missing = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sme' }),
  });
  check('missing password -> 400', missing.status === 400, `(got ${missing.status})`);
}

console.log('\n[A staff user signs in and gets a session]');
let smeCookie = '';
{
  const r = await login('sme', PW);
  check('sme login -> 200', r.status === 200, `(got ${r.status})`);
  check('login returns role sme', r.body.role === 'sme', `(role=${r.body.role})`);
  check('login sets a session cookie', r.cookie.includes('mh_session'), `(cookie=${r.cookie.slice(0, 24)}…)`);
  smeCookie = r.cookie;
}

console.log('\n[The session cookie authenticates — no X-User-Id header needed]');
{
  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: smeCookie } });
  const meBody = await me.json().catch(() => ({}));
  check('GET /api/me with cookie -> 200', me.status === 200, `(got ${me.status})`);
  check('/api/me reports role sme', meBody.role === 'sme', `(role=${meBody.role})`);
  check('/api/me has a display name', typeof meBody.display_name === 'string' && meBody.display_name.length > 0);

  const q = await fetch(`${BASE}/api/mission-quality`, { headers: { Cookie: smeCookie } });
  check('GET /api/mission-quality with cookie -> 200', q.status === 200, `(got ${q.status})`);
}

console.log('\n[Unauthenticated /api/me is 401 so the UI can redirect to /login]');
{
  const anon = await fetch(`${BASE}/api/me`);
  check('GET /api/me without cookie -> 401', anon.status === 401, `(got ${anon.status})`);
}

console.log('\n[Logout clears the session]');
{
  const out = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { Cookie: smeCookie } });
  const outCookie = cookieHeader(out);
  check('POST /api/logout -> 200', out.status === 200, `(got ${out.status})`);
  // The response resets the cookie; re-checking with the CLEARED cookie is 401.
  const me = await fetch(`${BASE}/api/me`, { headers: outCookie ? { Cookie: outCookie } : {} });
  check('GET /api/me after logout -> 401', me.status === 401, `(got ${me.status})`);
}

console.log('\n[Admin can sign in too and reach the staff roster]');
{
  const r = await login('admin', PW);
  check('admin login -> 200', r.status === 200, `(got ${r.status})`);
  const roster = await fetch(`${BASE}/api/students`, { headers: { Cookie: r.cookie } });
  check('admin session -> /api/students = 200', roster.status === 200, `(got ${roster.status})`);
}

console.log(`\n==== Staff auth: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
