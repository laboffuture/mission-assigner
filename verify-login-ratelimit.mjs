// Login rate-limit acceptance harness.
// Proves POST /login locks a username after 5 failed attempts (429), does not
// leak whether the username exists, and clears on a successful login.
// Requires the server on :3000 with ENABLE_TEST_HOOKS=1 and a fresh seed
// (staff default password 'changeme'). Run: npm run verify:login-ratelimit
import 'dotenv/config';

const BASE = 'http://localhost:3000';
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`))
       : (fail++, console.log(`  FAIL ${name} ${detail}`));
}

async function attempt(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function reset(username) {
  await fetch(`${BASE}/api/test/reset-rate-limit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(username ? { username } : {}),
  });
}

// Run N wrong-password attempts, return the status sequence.
async function sequence(username, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await attempt(username, 'definitely-wrong')).status);
  return out;
}

console.log('\n[After 5 failed attempts the username is locked (429)]');
{
  await reset('sme');
  const first5 = await sequence('sme', 5);
  check('first 5 attempts all 401', first5.every((s) => s === 401), `(seq=${first5.join(',')})`);
  const sixth = await attempt('sme', 'definitely-wrong');
  check('6th attempt -> 429', sixth.status === 429, `(got ${sixth.status})`);
  check('429 carries a generic message', /too many/i.test(sixth.body?.error?.message ?? ''));
}

console.log('\n[Even the CORRECT password is refused once locked]');
{
  // sme is still locked from the block above.
  const locked = await attempt('sme', PW);
  check('correct password while locked -> 429', locked.status === 429, `(got ${locked.status})`);
}

console.log("\n[Lockout does not reveal whether the username exists]");
{
  await reset('sme');
  await reset('ghost-user-xyz');
  const existing = [...(await sequence('sme', 5)), (await attempt('sme', 'x')).status];
  const missing = [...(await sequence('ghost-user-xyz', 5)), (await attempt('ghost-user-xyz', 'x')).status];
  check('existing user sequence == non-existent user sequence',
    JSON.stringify(existing) === JSON.stringify(missing), `(existing=${existing.join(',')} missing=${missing.join(',')})`);
  check('both end in 429', existing[5] === 429 && missing[5] === 429);
  // Bodies must be identical too (no distinguishing text).
  const eBody = (await attempt('sme', 'x')).body;
  const mBody = (await attempt('ghost-user-xyz', 'x')).body;
  check('429 bodies identical for existing vs missing',
    JSON.stringify(eBody?.error?.message) === JSON.stringify(mBody?.error?.message));
}

console.log('\n[A successful login clears the counter]');
{
  await reset('sme');
  const four = await sequence('sme', 4);
  check('4 failed attempts all 401', four.every((s) => s === 401), `(seq=${four.join(',')})`);
  const good = await attempt('sme', PW);
  check('5th attempt with correct password -> 200', good.status === 200, `(got ${good.status})`);
  // Counter cleared: another 4 failures should NOT be immediately blocked.
  const again = await sequence('sme', 4);
  check('post-success failures not immediately locked', again.every((s) => s === 401), `(seq=${again.join(',')})`);
}

// Leave the limiter clean so later suites' logins are unaffected.
await reset();

console.log(`\n==== Login rate limit: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
