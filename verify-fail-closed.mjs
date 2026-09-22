// Production must FAIL CLOSED (audit #1, #2, #3, #5, #6).
//
// Every insecure configuration attempted under NODE_ENV=production must refuse
// to start (or refuse to run) and name the reason; a valid production config
// must still boot, with dev auth and /api/test/* unreachable. Destructive
// scripts refuse under production unless an explicit override flag is passed.
// Sessions carry an issue time and are rejected server-side once older than
// SESSION_MAX_AGE, whatever the cookie's own expiry says.
//
// Every server spawned here uses a throwaway scratch database — never the dev DB.
// Requires the dev API on :3000 (sessions section) and MySQL.
// Run: npm run verify:fail-closed
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawn, spawnSync } from 'node:child_process';
import { killTree, TREE_OPTS } from './test-support/proc.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Keygrip from 'keygrip';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DBPASS = process.env.DB_PASS ?? 'devpass';
const SCRATCH = 'mission_demo_failclosed';
const PROD_SECRET = 'p'.repeat(48);
const OVERRIDE = '--i-understand-this-destroys-production-data';

let pass = 0,
  fail = 0;
/** Records a result and RETURNS the condition, so it can gate dependent checks. */
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
  return !!cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mysql.createConnection({
  host: process.env.DB_HOST ?? '127.0.0.1',
  user: process.env.DB_USER ?? 'root',
  password: DBPASS,
  multipleStatements: true,
});
const q = async (sql, p = []) => (await root.query(sql, p))[0];

/**
 * Env for a child process: the parent's, minus anything that would leak dev
 * behaviour in. The project .env sets AUTH_MODE=dev, and a child's own
 * `dotenv/config` would silently re-fill any variable removed here — so point
 * the child's dotenv at a file that does not exist. Each case then runs with
 * exactly the environment it names.
 */
function childEnv(overrides) {
  const env = { ...process.env, DB_NAME: SCRATCH, DOTENV_CONFIG_PATH: join(ROOT, '.env.does-not-exist') };
  for (const k of ['ENABLE_TEST_HOOKS', 'AUTH_MODE', 'SESSION_SECRET', 'NODE_ENV', 'SESSION_MAX_AGE']) delete env[k];
  for (const [k, v] of Object.entries(overrides))
    if (v === undefined) delete env[k];
    else env[k] = v;
  return env;
}
function node(args, overrides) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
    cwd: ROOT,
    env: childEnv(overrides),
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function bash(script, args, overrides) {
  const r = spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    env: childEnv(overrides),
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Start the real server; resolve when it listens or exits (a refusal). */
async function boot(port, overrides) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: childEnv({ PORT: String(port), ...overrides }),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...TREE_OPTS,
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) return { refused: true, code: child.exitCode, out, stop() {} };
    try {
      await fetch(`${base}/login`, { signal: AbortSignal.timeout(1000) });
      return {
        refused: false,
        base,
        out: () => out,
        stop: () => killTree(child.pid),
      };
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  child.kill();
  return { refused: false, timedOut: true, out, stop() {} };
}

// ------------------------------------------------------------ scratch DB --
await q(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
const mig = node(['src/migrator.ts', 'up'], {});
if (mig.code !== 0) {
  console.log(`FATAL: could not migrate scratch DB: ${mig.out.slice(-300)}`);
  process.exit(2);
}
// A student row so dev-header authentication would have someone to impersonate.
await q(
  `INSERT INTO \`${SCRATCH}\`.students (id, display_name, age, subject, current_level, placement_status) VALUES (501, 'Victim Student', 14, 'Computer Science', 1, 'complete')`
);

// ================================================================ boot ==
const PROD = { NODE_ENV: 'production', SESSION_SECRET: PROD_SECRET };

console.log('\n[1] NODE_ENV=production with AUTH_MODE unset refuses to boot');
{
  const r = await boot(3021, { ...PROD });
  const out = String(typeof r.out === 'function' ? r.out() : r.out).replace(/\s+/g, ' ');
  check('refused (did not listen)', r.refused, r.refused ? `(exit ${r.code})` : '(it booted)');
  check(
    'fatal message says AUTH_MODE is unset and must be set explicitly',
    r.refused && /AUTH_MODE/.test(out) && /must be set explicitly/.test(out),
    `(${out.slice(out.indexOf('FATAL'), out.indexOf('FATAL') + 200)})`
  );
  r.stop();
}

console.log('\n[2] NODE_ENV=production with AUTH_MODE=dev refuses to boot');
{
  const r = await boot(3022, { ...PROD, AUTH_MODE: 'dev' });
  const out = String(typeof r.out === 'function' ? r.out() : r.out).replace(/\s+/g, ' ');
  check('refused (did not listen)', r.refused, r.refused ? `(exit ${r.code})` : '(it booted)');
  check(
    'fatal message says AUTH_MODE=dev is not allowed',
    r.refused && /AUTH_MODE=dev is not allowed/.test(out),
    `(${out.slice(out.indexOf('FATAL'), out.indexOf('FATAL') + 200)})`
  );
  r.stop();
}

console.log('\n[3] NODE_ENV=production with ENABLE_TEST_HOOKS set refuses to boot');
{
  const r = await boot(3023, { ...PROD, AUTH_MODE: 'lti', ENABLE_TEST_HOOKS: '1' });
  check('refused (did not listen)', r.refused, r.refused ? `(exit ${r.code})` : '(it booted)');
  check('fatal message names ENABLE_TEST_HOOKS', r.refused && /ENABLE_TEST_HOOKS/.test(r.out));
  r.stop();
}

console.log('\n[4] NODE_ENV=production without SESSION_SECRET refuses to boot');
{
  const r = await boot(3024, { NODE_ENV: 'production', AUTH_MODE: 'lti' });
  check('refused (did not listen)', r.refused, r.refused ? `(exit ${r.code})` : '(it booted)');
  check('fatal message names SESSION_SECRET', r.refused && /SESSION_SECRET/.test(r.out));
  r.stop();
}

console.log('\n[5] A valid production config boots, with dev auth and test hooks unreachable');
{
  const r = await boot(3025, { ...PROD, AUTH_MODE: 'lti' });
  if (
    !check(
      'valid production config boots',
      !r.refused && !r.timedOut,
      r.refused ? `(refused: ${String(r.out).slice(-200)})` : ''
    )
  ) {
    /* nothing more to test */
  } else {
    for (const [m, p] of [
      ['GET', '/api/test/logs'],
      ['POST', '/api/test/feedback-gating'],
      ['POST', '/api/test/reset-rate-limit'],
      ['GET', '/api/dev/users'],
      ['POST', '/api/dev/login-as'],
    ]) {
      const s = (
        await fetch(r.base + p, {
          method: m,
          headers: { 'Content-Type': 'application/json' },
          body: m === 'POST' ? '{"studentId":501,"enabled":false}' : undefined,
        })
      ).status;
      check(`${m} ${p} unreachable`, s === 404, `(got ${s})`);
    }
    const me = await fetch(`${r.base}/api/progress/501`, { headers: { 'X-User-Id': '501' } });
    check('a forged X-User-Id header does not authenticate', me.status !== 200, `(got ${me.status})`);
  }
  r.stop();
}

console.log(
  '\n[6] Defence in depth: dev auth and test hooks are off in production even if the env check were bypassed'
);
{
  const probe = node(
    [
      '-e',
      `process.env.NODE_ENV='production'; process.env.ENABLE_TEST_HOOKS='1'; process.env.AUTH_MODE='dev';
       const a = await import('./src/auth.ts'); const t = await import('./src/testHooks.ts');
       let threw = false; try { a.resetAuthProvider(); a.getAuthProvider(); } catch { threw = true; }
       console.log(JSON.stringify({ hooks: t.testHooksEnabled(), devProviderThrew: threw }));`,
    ],
    {}
  );
  const m = /\{"hooks".*\}/.exec(probe.out);
  const j = m ? JSON.parse(m[0]) : null;
  check(
    'testHooksEnabled() is false under production',
    j?.hooks === false,
    `(${m?.[0] ?? probe.out.slice(-160).replace(/\s+/g, ' ')})`
  );
  check('getAuthProvider() refuses dev under production', j?.devProviderThrew === true, `(${m?.[0] ?? 'n/a'})`);
}

// ======================================================= destructive ops ==
const marker = async () =>
  Number((await q(`SELECT COUNT(*) n FROM \`${SCRATCH}\`.students WHERE display_name = 'Victim Student'`))[0].n);

console.log('\n[7] db:seed refuses under production without the override flag');
{
  const r = node(['src/seed.ts'], { NODE_ENV: 'production', SESSION_SECRET: PROD_SECRET });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check(
    'names the refusal and the override flag',
    /production/i.test(r.out) && r.out.includes(OVERRIDE),
    `(${r.out.replace(/\s+/g, ' ').slice(-180)})`
  );
  check('no table touched (marker row survives)', (await marker()) === 1);
}

console.log('\n[8] db:seed with the override flag does run under production');
{
  const r = node(['src/seed.ts', OVERRIDE], { NODE_ENV: 'production', SESSION_SECRET: PROD_SECRET });
  check('exits 0', r.code === 0, `(exit ${r.code} ${r.out.slice(-160).replace(/\s+/g, ' ')})`);
  check('it really ran (marker row truncated away)', (await marker()) === 0);
  await q(
    `INSERT INTO \`${SCRATCH}\`.students (id, display_name, age, subject, current_level, placement_status) VALUES (501, 'Victim Student', 14, 'Computer Science', 1, 'complete')`
  );
}

const migCount = async () => Number((await q(`SELECT COUNT(*) n FROM \`${SCRATCH}\`.schema_migrations`))[0].n);
for (const [n, cmd] of [
  [9, 'down'],
  [10, 'down:all'],
]) {
  console.log(`\n[${n}] migrate ${cmd} refuses under production without the override flag`);
  const before = await migCount();
  const r = node(['src/migrator.ts', cmd], { NODE_ENV: 'production', SESSION_SECRET: PROD_SECRET });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check(
    'names the refusal and the override flag',
    r.out.includes(OVERRIDE),
    `(${r.out.replace(/\s+/g, ' ').slice(-160)})`
  );
  check('nothing reverted', (await migCount()) === before, `(${before} -> ${await migCount()})`);
}

console.log('\n[11] scripts/restore.sh refuses under production without the override flag');
{
  const dumps = existsSync(join(ROOT, 'backups'))
    ? readdirSync(join(ROOT, 'backups')).filter((f) => f.endsWith('.sql.gz'))
    : [];
  const file =
    dumps.map((f) => join('backups', f)).find((f) => spawnSync('gzip', ['-t', f]).status === 0) ?? 'package.json';
  const r = bash('scripts/restore.sh', [file, SCRATCH], { NODE_ENV: 'production' });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check(
    'names the refusal and the override flag',
    r.out.includes(OVERRIDE),
    `(${r.out.replace(/\s+/g, ' ').slice(-160)})`
  );
  check('target untouched (marker row survives)', (await marker()) === 1);
}

console.log('\n[12] demo-reset.sh refuses under production without the override flag');
{
  const r = bash('demo-reset.sh', [], { NODE_ENV: 'production' });
  check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
  check(
    'names the refusal and the override flag',
    r.out.includes(OVERRIDE),
    `(${r.out.replace(/\s+/g, ' ').slice(-160)})`
  );
}

// ============================================================== sessions ==
const secret = (await import('./src/session.ts')).sessionSecret();
const kg = new Keygrip([secret]);
const sign = (payload) => {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `mh_session=${value}; mh_session.sig=${kg.sign(`mh_session=${value}`)}`;
};
const meWith = async (cookie, base = BASE) => (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status;
const loginCookie = async (base = BASE) => {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'instructor', password: 'changeme' }),
  });
  return { status: r.status, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
};
await fetch(`${BASE}/api/test/reset-rate-limit`, { method: 'POST' }).catch(() => {});

console.log('\n[13] A new session carries a server-checkable issue time');
const fresh = await loginCookie();
const payload = JSON.parse(
  Buffer.from(/mh_session=([^;]+)/.exec(fresh.cookie)?.[1] ?? '', 'base64').toString('utf8') || '{}'
);
{
  check('login succeeds', fresh.status === 200, `(got ${fresh.status})`);
  const now = Math.floor(Date.now() / 1000);
  check(
    'payload has iat (seconds, ~now)',
    Number.isInteger(payload.iat) && Math.abs(payload.iat - now) < 60,
    `(payload=${JSON.stringify(payload)})`
  );
  check('fresh session -> 200', (await meWith(fresh.cookie)) === 200);
}

console.log('\n[14] A validly signed session older than SESSION_MAX_AGE is rejected (401)');
{
  const uid = payload.uid ?? 4;
  const old = sign({ uid, iat: Math.floor(Date.now() / 1000) - 13 * 3600 });
  check('13h-old session -> 401', (await meWith(old)) === 401, `(got ${await meWith(old)})`);
  const legacy = sign({ uid });
  check('signed legacy session with no iat -> 401', (await meWith(legacy)) === 401, `(got ${await meWith(legacy)})`);
  const future = sign({ uid, iat: Math.floor(Date.now() / 1000) + 3600 });
  check('session issued in the future -> 401', (await meWith(future)) === 401, `(got ${await meWith(future)})`);
}

console.log('\n[15] Real-time expiry: SESSION_MAX_AGE=2 rejects the same cookie after 3s');
{
  const r = await boot(3026, {
    ENABLE_TEST_HOOKS: '1',
    SESSION_MAX_AGE: '2',
    DB_NAME: process.env.DB_NAME ?? 'mission_demo',
  });
  if (check('instance started', !r.refused && !r.timedOut, r.refused ? String(r.out).slice(-200) : '')) {
    await fetch(`${r.base}/api/test/reset-rate-limit`, { method: 'POST' });
    const l = await loginCookie(r.base);
    check('fresh -> 200', (await meWith(l.cookie, r.base)) === 200, `(login ${l.status})`);
    await sleep(3200);
    check(
      'same cookie after 3.2s -> 401',
      (await meWith(l.cookie, r.base)) === 401,
      `(got ${await meWith(l.cookie, r.base)})`
    );
  }
  r.stop();
}

await q(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await root.end();
console.log(`\n==== Fail-closed: ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
