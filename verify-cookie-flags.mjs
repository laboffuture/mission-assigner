// Session cookie flags acceptance harness.
// Confirms the session cookie is HttpOnly, carries the configured SameSite, and
// is Secure exactly when it must be (production, or SameSite=None). Checks both
// the pure policy (cookieFlags) across environments AND the live Set-Cookie
// header from POST /api/login on the running dev server.
// Requires the server on :3000 with a fresh seed. Run: npm run verify:cookie-flags
import 'dotenv/config';
import { cookieFlags } from './src/session.js';

const BASE = 'http://localhost:3000';
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

console.log('\n[Cookie flag policy is correct across environments]');
{
  const dev = cookieFlags({ NODE_ENV: 'development' });
  check('dev: httpOnly on', dev.httpOnly === true);
  check('dev: sameSite lax by default', dev.sameSite === 'lax', `(got ${dev.sameSite})`);
  check('dev: not Secure (allows http://localhost)', dev.secure === false, `(got ${dev.secure})`);

  const prod = cookieFlags({ NODE_ENV: 'production' });
  check('prod: Secure on', prod.secure === true);
  check('prod: httpOnly on', prod.httpOnly === true);

  const none = cookieFlags({ NODE_ENV: 'development', SESSION_SAMESITE: 'none' });
  check('sameSite=none forces Secure (even in dev)', none.secure === true, `(secure=${none.secure})`);
  check('sameSite=none is passed through', none.sameSite === 'none');

  const strict = cookieFlags({ NODE_ENV: 'production', SESSION_SAMESITE: 'strict' });
  check('strict honoured', strict.sameSite === 'strict' && strict.secure === true);
}

console.log('\n[The live login Set-Cookie carries the expected flags (dev server)]');
{
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sme', password: PW }),
  });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sessionCookie = setCookies.find((c) => c.startsWith('mh_session=')) ?? '';
  check('login sets mh_session', sessionCookie.length > 0, `(cookies=${setCookies.length})`);
  check('HttpOnly present', /;\s*httponly/i.test(sessionCookie));
  check('SameSite=Lax present', /;\s*samesite=lax/i.test(sessionCookie), `(cookie=${sessionCookie})`);
  check('Secure absent on dev http', !/;\s*secure/i.test(sessionCookie));
}

console.log('\n[The LMS theme travels in the session, not in a cookie of its own]');
{
  // The theme used to be its own cookie, SameSite=None; Secure, so it would
  // survive the LMS's cross-site iframe. WebKit will not send a Secure cookie to
  // an http origin at all (every theme test failed on Safari and iPad) and Safari
  // blocks third-party cookies in an iframe anyway, so it would not have survived
  // the case it was written for. It now rides in the session we already issue.
  const login = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: 9, theme: 'horizon' }),
  });
  check('dev login-as accepts a theme', login.status === 200, `(got ${login.status})`);
  const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  check(
    'it does NOT set a theme cookie of its own',
    !setCookies.some((c) => /^lof_theme=/.test(c)),
    `(${setCookies.map((c) => c.split('=')[0]).join(', ')})`
  );
  check('nothing it sets is Secure on http', !setCookies.some((c) => /;\s*secure/i.test(c)));

  const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
  check('the session reports the theme', me.theme === 'horizon', `(theme=${JSON.stringify(me.theme)})`);

  // An invalid theme is ignored rather than stored and echoed back.
  const bad = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: 9, theme: 'midnight' }),
  });
  check('an unknown theme is rejected, not stored', bad.status === 400, `(got ${bad.status})`);

  const plain = await fetch(`${BASE}/api/dev/login-as`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: 9 }),
  });
  const plainCookie = (typeof plain.headers.getSetCookie === 'function' ? plain.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const plainMe = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: plainCookie } })).json();
  check('a session issued without one carries no theme', plainMe.theme === null, `(theme=${JSON.stringify(plainMe.theme)})`);
}

console.log(`\n==== Cookie flags: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
