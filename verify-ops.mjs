// Batch A operational readiness: health probes, readiness, graceful shutdown,
// and production secret validation.
//
//   [1] /healthz answers while the database is DOWN (liveness ≠ readiness) and
//       leaks nothing.
//   [2] /readyz is 503 without a database, 503 with the schema behind this
//       build, and 200 when both are right.
//   [3] SIGTERM during an in-flight submission: the submission COMPLETES and
//       grades exactly once, then the process exits 0.
//   [4] production refuses to boot while a secret still holds an example
//       placeholder, naming the variable.
//
// Spawns its own API instances; needs MySQL, not the shared :3000 server.
// Run: npm run verify:ops
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, listenerPid, TREE_OPTS } from './test-support/proc.mjs';
import { pool as appPool } from './src/db.js';
import { assignSegment } from './src/segmentation.js';
import { applyColdStart } from './src/coldstart.js';
import { publishWeek } from './src/weekPublisher.js';

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  timezone: 'Z',
});
let pass = 0,
  fail = 0;
function check(name, cond, detail = '') {
  cond ? (pass++, console.log(`  PASS ${name} ${detail}`)) : (fail++, console.log(`  FAIL ${name} ${detail}`));
  return !!cond;
}
const q = async (sql, p = []) => (await db.query(sql, p))[0];

/** Start an API instance. Returns the child so a signal can be sent to it. */
async function startApi(port, env = {}, { waitForReady = true } = {}) {
  const stale = listenerPid(port);
  if (stale) killTree(stale);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), ENABLE_TEST_HOOKS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...TREE_OPTS,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let exited = null;
  child.on('exit', (code) => (exited = code));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60 && exited == null; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok || !waitForReady) return { child, base, log: () => log, exited: () => exited };
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return { child, base, log: () => log, exited: () => exited, failed: true };
}
const get = async (base, path) => {
  const r = await fetch(base + path).catch((e) => ({ status: 0, text: async () => String(e?.cause?.code ?? e) }));
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, text, json };
};

// ------------------------------------------------------------------------ [1]
console.log('\n[1] /healthz is about the PROCESS, so it answers even with no database');
{
  const api = await startApi(3041, { DB_PORT: '1' }); // nothing listens on :1
  try {
    if (!check('instance started despite an unreachable database', !api.failed, api.log().slice(-200))) throw 0;
    const h = await get(api.base, '/healthz');
    check('/healthz -> 200', h.status === 200, `(got ${h.status})`);
    check('  ...says only that it is ok', JSON.stringify(h.json) === '{"status":"ok"}', `(${h.text.slice(0, 120)})`);
    check(
      '  ...no version, host, schema or error text',
      !/version|mysql|schema|127\.0\.0\.1|ECONN|password/i.test(h.text),
      `(${h.text.slice(0, 120)})`
    );
    const r = await get(api.base, '/readyz');
    check('/readyz -> 503 with the database down', r.status === 503, `(got ${r.status})`);
    check('  ...reason is "database", with no internals', r.json?.reason === 'database', `(${r.text.slice(0, 120)})`);
  } catch {
    /* startup failure already recorded */
  } finally {
    killTree(listenerPid(3041) ?? api.child.pid);
  }
}

// ------------------------------------------------------------------------ [2]
console.log('\n[2] /readyz also fails when the schema is behind this build');
{
  const SCRATCH = 'mission_demo_ops_ready';
  await q(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await q(`CREATE DATABASE \`${SCRATCH}\``);
  // Migrated to 009 only: the code expects more, so this is NOT ready.
  const { buildUmzug, makePool, MIGRATION_NAMES } = await import('./src/migrator.js');
  const mpool = makePool(SCRATCH);
  await buildUmzug(mpool).up({ to: '009_curriculum' });
  await mpool.end();

  const behind = await startApi(3042, { DB_NAME: SCRATCH });
  try {
    const r = await get(behind.base, '/readyz');
    check('/readyz -> 503 when migrations are pending', r.status === 503, `(got ${r.status})`);
    check('  ...reason is "schema"', r.json?.reason === 'schema', `(${r.text.slice(0, 120)})`);
    check(
      '  ...does not name the migrations',
      !r.text.includes('curriculum') && !r.text.includes('idempotency'),
      `(${r.text.slice(0, 160)})`
    );
  } finally {
    killTree(listenerPid(3042) ?? behind.child.pid);
  }

  // Fully migrated: ready.
  const mpool2 = makePool(SCRATCH);
  await buildUmzug(mpool2).up();
  await mpool2.end();
  const ready = await startApi(3043, { DB_NAME: SCRATCH });
  try {
    const r = await get(ready.base, '/readyz');
    check('/readyz -> 200 once the schema matches', r.status === 200, `(got ${r.status} ${r.text.slice(0, 120)})`);
    check(
      '  ...says only that it is ready',
      JSON.stringify(r.json) === '{"status":"ready"}',
      `(${r.text.slice(0, 120)})`
    );
    check('  ...and every migration is applied', MIGRATION_NAMES.length > 0);
  } finally {
    killTree(listenerPid(3043) ?? ready.child.pid);
    await q(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  }
}

// ------------------------------------------------------------------------ [3]
console.log('\n[3] SIGTERM during a submission: it finishes and grades exactly once');
{
  const api = await startApi(3044);
  let sid = null;
  let aid = null;
  const holder = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
  try {
    if (!check('instance started', !api.failed, api.log().slice(-300))) throw 0;
    // A student with an open assignment.
    const r = await q(
      `INSERT INTO students (display_name, age, subject, current_level, placement_status)
       VALUES (?, 15, 'Computer Science', 0, 'pending')`,
      [`OPS-sigterm-${Date.now()}`]
    );
    sid = Number(r.insertId);
    await q(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?, 'CS-101', NOW())`, [sid]);
    await assignSegment(sid);
    await applyColdStart(sid);
    await publishWeek(sid, '2026-12-07');
    const week = await (await fetch(`${api.base}/api/week/${sid}`, { headers: { 'X-User-Id': String(sid) } })).json();
    const slot = week.slots.find((s) => s.status === 'open');
    const open = await (
      await fetch(`${api.base}/api/slot/${slot.slot_id}/open`, {
        method: 'POST',
        headers: { 'X-User-Id': String(sid) },
      })
    ).json();
    aid = open.assignment_id;
    const [[m]] = await holder.query(
      `SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
      [aid]
    );
    const ak = typeof m.ak === 'string' ? JSON.parse(m.ak) : m.ak;

    // Hold the assignment row so the submit blocks INSIDE its transaction —
    // the request is genuinely in flight when the signal arrives, with no
    // sleeps to race against.
    await holder.query('START TRANSACTION');
    await holder.query(`SELECT id FROM assignments WHERE id = ? FOR UPDATE`, [aid]);

    const submitPromise = fetch(`${api.base}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(sid) },
      body: JSON.stringify({ assignmentId: aid, selected: ak.correct }),
    })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .catch((e) => ({ status: 0, body: null, err: String(e?.cause?.code ?? e?.message ?? e) }));

    await sleep(1500); // the request is now blocked on the row lock

    // Windows cannot deliver SIGTERM to another process (process.kill maps to
    // TerminateProcess and kills outright), so there the same handler is run
    // through the test hook. CI is Linux and sends the real signal.
    const WIN = process.platform === 'win32';
    if (WIN) {
      await fetch(`${api.base}/api/test/shutdown`, { method: 'POST' });
      console.log('    NOTE signal path: test hook (this OS cannot deliver SIGTERM); CI sends the real signal');
    } else {
      process.kill(listenerPid(3044) ?? api.child.pid, 'SIGTERM');
      console.log('    NOTE signal path: real SIGTERM');
    }
    await sleep(1000);

    // New work is refused while draining. The listener is closed the moment the
    // signal lands, so a NEW connection is refused outright; a request already
    // on a kept-alive connection gets 503 shutting_down. Either is a refusal —
    // what must not happen is a new request being accepted and served.
    const during = await get(api.base, '/healthz');
    check(
      'new requests are refused while draining',
      during.status === 0 || during.status === 503,
      `(got ${during.status}${during.status === 0 ? ' — connection refused' : ` ${during.text.slice(0, 60)}`})`
    );

    // ...and the in-flight one completes once the lock is released.
    await holder.query('ROLLBACK');
    const submitted = await submitPromise;
    check(
      'the in-flight submission completed (not cut off)',
      submitted.status === 200,
      `(status=${submitted.status}${submitted.err ? ` err=${submitted.err}` : ''})`
    );
    const graded = Number(
      (await q(`SELECT COUNT(*) n FROM attempt_logs WHERE assignment_id = ? AND event = 'graded'`, [aid]))[0].n
    );
    check('graded exactly once', graded === 1, `(graded events=${graded})`);
    for (let i = 0; i < 40 && api.exited() == null; i++) await sleep(250);
    check('the process exited 0 after draining', api.exited() === 0, `(exit=${api.exited()})`);
  } catch {
    /* recorded above */
  } finally {
    await holder.end().catch(() => {});
    killTree(listenerPid(3044) ?? api.child.pid);
    if (sid) await q(`DELETE FROM students WHERE id = ?`, [sid]).catch(() => {});
  }
}

// ------------------------------------------------------------------------ [5]
console.log('\n[5] Behind a TLS-terminating proxy, the Secure session cookie is still set');
{
  // The deployed stack puts Caddy in front: TLS ends there and this process sees
  // plain HTTP. Express only believes X-Forwarded-Proto when it trusts the
  // proxy; without that, cookie-session silently declines to set a Secure
  // cookie and NOBODY can sign in. Caught by the CI stack journey, so it has a
  // test here too.
  const trusting = await startApi(3046, { SESSION_SAMESITE: 'none', TRUST_PROXY: '1', AUTH_MODE: 'dev' });
  const blind = await startApi(3047, { SESSION_SAMESITE: 'none', TRUST_PROXY: '', AUTH_MODE: 'dev' });
  try {
    const [[student]] = await db.query(`SELECT id FROM students WHERE role = 'student' ORDER BY id LIMIT 1`);
    const login = async (base) => {
      const r = await fetch(`${base}/api/dev/login-as`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
        body: JSON.stringify({ studentId: Number(student.id) }),
      });
      return { status: r.status, cookies: (r.headers.getSetCookie?.() ?? []).join(' ') };
    };
    const good = await login(trusting.base);
    check('login succeeds behind the proxy', good.status === 200, `(got ${good.status})`);
    check(
      'TRUST_PROXY=1: the session cookie IS set on a forwarded https request',
      /mh_session=/.test(good.cookies),
      `(set-cookie: ${good.cookies.slice(0, 120) || 'none'})`
    );
    check('  ...and it is marked Secure', /secure/i.test(good.cookies), `(${good.cookies.slice(0, 120)})`);

    const bad = await login(blind.base);
    check(
      'without TRUST_PROXY the same request sets NO session (the bug this guards)',
      !/mh_session=/.test(bad.cookies),
      `(set-cookie: ${bad.cookies.slice(0, 120) || 'none'})`
    );
  } finally {
    killTree(listenerPid(3046) ?? trusting.child.pid);
    killTree(listenerPid(3047) ?? blind.child.pid);
  }
}

// ------------------------------------------------------------------------ [4]
console.log('\n[4] Production refuses to boot on a placeholder secret');
{
  const PLACEHOLDERS = [
    ['SESSION_SECRET', 'replace-me-with-openssl-rand-hex-32'],
    ['DB_PASS', 'change-me'],
  ];
  for (const [name, value] of PLACEHOLDERS) {
    const env = {
      NODE_ENV: 'production',
      AUTH_MODE: 'lti',
      ENABLE_TEST_HOOKS: '',
      SESSION_SECRET: 'f'.repeat(64),
      DB_PASS: process.env.DB_PASS,
      [name]: value,
      DOTENV_CONFIG_PATH: 'no-such-env-file',
    };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: '3045', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    check(`${name}=<placeholder> refuses to boot`, code !== 0, `(exit=${code})`);
    check(`  ...and names ${name}`, out.includes(name), `(${out.replace(/\s+/g, ' ').slice(-200)})`);
  }
}

await db.end();
// Importing the app's modules (segmentation, coldstart, weekPublisher) creates
// the shared pool in src/db.ts. Leaving it open holds the event loop open, so
// this process printed its result and then never exited — which is how it
// stalled run-all.mjs until the timeout.
await appPool.end();
console.log(`\n==== Ops: ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
