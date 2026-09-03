// Double-submit CSRF harness. Runs via tsx: it mounts the REAL csrfMiddleware on
// a throwaway express app on an ephemeral port and toggles CSRF_ENFORCED between
// requests (the flag is read at request time), so both the default (issue-only)
// and enforced modes are exercised without touching the main server.
// Run: npm run verify:csrf
import express from 'express';
import { csrfMiddleware, csrfEnforced, readCookie, CSRF_COOKIE, CSRF_HEADER } from './src/csrf.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

// ---- Unit: env parsing -----------------------------------------------------
console.log('\n[csrfEnforced() parses the flag]');
{
  check("'true' -> enforced", csrfEnforced({ CSRF_ENFORCED: 'true' }) === true);
  check("'1' -> enforced", csrfEnforced({ CSRF_ENFORCED: '1' }) === true);
  check("'yes' -> enforced", csrfEnforced({ CSRF_ENFORCED: 'YES' }) === true);
  check("'false' -> not enforced", csrfEnforced({ CSRF_ENFORCED: 'false' }) === false);
  check('unset -> not enforced (default)', csrfEnforced({}) === false);
}

// ---- Unit: readCookie ------------------------------------------------------
console.log('\n[readCookie() extracts one cookie from the header]');
{
  const req = { headers: { cookie: `a=1; ${CSRF_COOKIE}=tok123; b=2` } };
  check('finds the target cookie', readCookie(req, CSRF_COOKIE) === 'tok123');
  check('returns null when absent', readCookie({ headers: {} }, CSRF_COOKIE) === null);
}

// ---- HTTP: mount the real middleware --------------------------------------
const app = express();
app.use(express.json());
app.use(csrfMiddleware());
app.get('/thing', (_req, res) => res.json({ ok: true }));
app.post('/thing', (_req, res) => res.json({ ok: true }));
app.post('/api/test/thing', (_req, res) => res.json({ ok: true }));

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
const setCookies = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
const csrfFromSet = (res) => {
  const c = setCookies(res).find((x) => x.startsWith(`${CSRF_COOKIE}=`));
  return c ? c.split(';')[0].slice(CSRF_COOKIE.length + 1) : null;
};

try {
  // Default (unenforced): cookie issued, mutations pass without a header.
  delete process.env.CSRF_ENFORCED;
  console.log('\n[Default (CSRF_ENFORCED unset): issue cookie, never reject]');
  {
    const get = await fetch(`${BASE}/thing`);
    const setLine = setCookies(get).find((x) => x.startsWith(`${CSRF_COOKIE}=`)) ?? '';
    check('GET issues an mh_csrf cookie', /mh_csrf=/.test(setLine));
    check('CSRF cookie is NOT HttpOnly (client must read it)', !/httponly/i.test(setLine), `(${setLine})`);
    check('CSRF cookie is SameSite=Lax by default', /samesite=lax/i.test(setLine));

    const post = await fetch(`${BASE}/thing`, { method: 'POST' });
    check('POST without header still succeeds when unenforced', post.status === 200, `(got ${post.status})`);
  }

  // Enforced: mutations require header === cookie.
  process.env.CSRF_ENFORCED = 'true';
  console.log('\n[Enforced (CSRF_ENFORCED=true): double-submit required on mutations]');
  {
    const noHeader = await fetch(`${BASE}/thing`, { method: 'POST' });
    check('POST without header -> 403', noHeader.status === 403, `(got ${noHeader.status})`);
    const body = await noHeader.json().catch(() => ({}));
    check('403 body has code csrf_failed', body?.error?.code === 'csrf_failed', `(${body?.error?.code})`);

    // Obtain a token, then echo it in the header WITH the matching cookie.
    const seed = await fetch(`${BASE}/thing`);
    const token = csrfFromSet(seed);
    check('obtained a token from a GET', typeof token === 'string' && token.length > 0);

    const wrong = await fetch(`${BASE}/thing`, {
      method: 'POST', headers: { Cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: 'not-the-token' },
    });
    check('POST with mismatched header -> 403', wrong.status === 403, `(got ${wrong.status})`);

    const good = await fetch(`${BASE}/thing`, {
      method: 'POST', headers: { Cookie: `${CSRF_COOKIE}=${token}`, [CSRF_HEADER]: token },
    });
    check('POST with matching header+cookie -> 200', good.status === 200, `(got ${good.status})`);

    // Safe methods and the dev-only test hooks are never gated.
    const getStill = await fetch(`${BASE}/thing`);
    check('GET is never gated (safe method)', getStill.status === 200, `(got ${getStill.status})`);
    const hook = await fetch(`${BASE}/api/test/thing`, { method: 'POST' });
    check('/api/test/* exempt even when enforced', hook.status === 200, `(got ${hook.status})`);
  }
} finally {
  delete process.env.CSRF_ENFORCED;
  server.close();
}

console.log(`\n==== CSRF: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
