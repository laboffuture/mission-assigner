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

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
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

console.log(`\n==== Cookie flags: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
