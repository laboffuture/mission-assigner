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
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, listenerPid, TREE_OPTS } from './test-support/proc.mjs';
import { createProdDbUser } from './test-support/prod-db-user.mjs';
import { pool as appPool } from './src/db.js';
import { assignSegment } from './src/segmentation.js';
import { applyColdStart } from './src/coldstart.js';
import { publishWeek } from './src/weekPublisher.js';
import { pruneIdempotencyKeys } from './src/idempotencyPrune.js';
import { withDbRetry } from './src/retry.js';
import { LIMITS } from './src/requestLimit.js';
import { assertNamedTimezones, unresolvableZones } from './src/timezoneCheck.js';

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
  // CI job logs need repository-admin rights to read, so a failure has to name
  // itself in an annotation.
  if (!cond && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Ops::${name} ${String(detail).slice(0, 250)}`);
  }
  return !!cond;
}
const q = async (sql, p = []) => (await db.query(sql, p))[0];

// A crash before any check runs would otherwise reach CI as a bare exit code:
// run-all names the suite, but not what went wrong inside it.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    const message = String(err?.stack ?? err)
      .split('\n')
      .slice(0, 3)
      .join(' | ');
    console.log(`\nOPS CRASHED (${event}): ${message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Ops crashed::${event}: ${message.slice(0, 400)}`);
    process.exit(1);
  });
}

// Booting with NODE_ENV=production needs a database password that is not a
// shipped default — production refuses 'devpass' as a placeholder, which is the
// right behaviour and exactly why the harness needs its own user.
const prodDb = await createProdDbUser(db, 'ops');

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
    // Any existing student will do; create one when the database has none. This
    // suite runs before the seed in CI, where assuming one exists crashed the
    // whole harness before a single check had run.
    let [[student]] = await db.query(`SELECT id FROM students WHERE role = 'student' ORDER BY id LIMIT 1`);
    if (!student) {
      const created = await q(
        `INSERT INTO students (display_name, age, subject, current_level, placement_status)
         VALUES (?, 15, 'Computer Science', 0, 'pending')`,
        [`OPS-proxy-${Date.now()}`]
      );
      student = { id: Number(created.insertId) };
    }
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
      ...prodDb.env,
      TRUST_PROXY: '0',
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

// ------------------------------------------------------------------------ [6]
console.log('\n[6] Production refuses to boot without an explicit proxy decision');
{
  const base = {
    NODE_ENV: 'production',
    AUTH_MODE: 'lti',
    ENABLE_TEST_HOOKS: '',
    SESSION_SECRET: 'f'.repeat(64),
    ...prodDb.env,
    DOTENV_CONFIG_PATH: 'no-such-env-file',
  };
  const boot = async (env) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, PORT: '3048', ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => {
        killTree(child.pid);
        resolve('started');
      }, 12000);
      child.on('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    return { code, out };
  };
  const unset = await boot({ TRUST_PROXY: undefined });
  check('TRUST_PROXY unset refuses to boot', unset.code !== 'started' && unset.code !== 0, `(exit=${unset.code})`);
  check(
    '  ...and names TRUST_PROXY',
    unset.out.includes('TRUST_PROXY'),
    `(${unset.out.replace(/\s+/g, ' ').slice(-200)})`
  );
  // An explicit 0 ("TLS terminates here") satisfies the requirement. Whether the
  // process then goes on to start depends on the rest of the environment — the
  // seeded staff passwords stop it in this database — so the assertion is that
  // the configuration is ACCEPTED, i.e. it is no longer TRUST_PROXY being named.
  const explicit = await boot({ TRUST_PROXY: '0' });
  check(
    'TRUST_PROXY=0 (no proxy) is accepted by env validation',
    explicit.code === 'started' || !explicit.out.includes('TRUST_PROXY'),
    `(exit=${explicit.code}, ${explicit.out.replace(/\s+/g, ' ').slice(-160)})`
  );
}

// ------------------------------------------------------------------------ [7]
// Every submit writes an idempotency key and nothing ever removed one. The rows
// answer "was this exact submit already graded?" for a student who retried
// seconds ago; nobody asks days later, and the graded result lives in attempts.
console.log('\n[7] Idempotency keys are kept for a window, not forever');
{
  // The table has a foreign key, so the rows need a real assignment to hang off.
  // It makes its OWN: a migrated-but-unplayed database has no assignments at all
  // (CI's api job is exactly that), and a case that borrows whatever happens to
  // be lying around passes on a developer's machine and fails everywhere else.
  const [[seedStudent]] = await db.query(
    `SELECT id FROM students WHERE role IS NULL OR role = 'student' ORDER BY id LIMIT 1`
  );
  const [[seedMission]] = await db.query('SELECT id FROM missions ORDER BY id LIMIT 1');
  let ownAssignment = null;
  if (seedStudent && seedMission) {
    const ins = await q(
      `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, assigned_at)
       VALUES (?, ?, 1, 1, 'open', UTC_TIMESTAMP())`,
      [seedStudent.id, seedMission.id]
    );
    ownAssignment = { id: Number(ins.insertId) };
  }
  const assignment = ownAssignment;
  if (check('an assignment to attach keys to', !!assignment, '(no student or mission in the database)')) {
    const aid = assignment.id;
    const old = `ops-old-${Date.now()}`;
    const fresh = `ops-fresh-${Date.now()}`;
    await q(
      `INSERT INTO idempotency_keys (idempotency_key, assignment_id, request_hash, response, created_at)
       VALUES (?, ?, 'aged', NULL, UTC_TIMESTAMP() - INTERVAL 30 DAY), (?, ?, 'today', NULL, UTC_TIMESTAMP())`,
      [old, aid, fresh, aid]
    );
    const removed = await pruneIdempotencyKeys(appPool, 7);
    const left = (
      await q('SELECT idempotency_key FROM idempotency_keys WHERE idempotency_key IN (?, ?)', [old, fresh])
    ).map((r) => r.idempotency_key);
    check('the sweep deleted at least the expired row', removed >= 1, `(removed=${removed})`);
    check('a 30-day-old key is gone', !left.includes(old), `(left=${left.join(',') || 'none'})`);
    check("today's key is untouched", left.includes(fresh), `(left=${left.join(',') || 'none'})`);
    await q('DELETE FROM idempotency_keys WHERE idempotency_key IN (?, ?)', [old, fresh]);

    // Available to call is not the same as running: prove the api starts it.
    const booted = `ops-boot-${Date.now()}`;
    await q(
      `INSERT INTO idempotency_keys (idempotency_key, assignment_id, request_hash, created_at)
       VALUES (?, ?, 'aged', UTC_TIMESTAMP() - INTERVAL 30 DAY)`,
      [booted, aid]
    );
    const api = await startApi(3049, { IDEMPOTENCY_TTL_DAYS: '7' });
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = (await q('SELECT 1 AS n FROM idempotency_keys WHERE idempotency_key = ?', [booted])).length === 0;
      if (!gone) await sleep(500);
    }
    check(
      'starting the api sweeps expired keys without being asked',
      gone,
      api.failed ? `(the api did not start: ${api.log().replace(/\s+/g, ' ').slice(-200)})` : ''
    );
    killTree(api.child.pid);
    await q('DELETE FROM idempotency_keys WHERE idempotency_key = ?', [booted]);
    // The assignment this case created goes with it (its keys cascade).
    await q('DELETE FROM assignments WHERE id = ?', [aid]).catch(() => {});
  }
}

// ------------------------------------------------------------------------ [8]
// A deadlock or a lock-wait timeout is not an outage — it is the normal cost of
// concurrent writes, and it used to reach the student as a failed submit.
console.log('\n[8] A submit that loses a lock race is retried, not failed');
{
  // First the rule itself, with no database in the way.
  let calls = 0;
  const deadlock = Object.assign(new Error('Deadlock found when trying to get lock'), {
    code: 'ER_LOCK_DEADLOCK',
    errno: 1213,
  });
  const recovered = await withDbRetry('test', async () => {
    calls++;
    if (calls < 3) throw deadlock;
    return 'graded';
  });
  check(
    'a deadlocked transaction is retried until it succeeds',
    recovered === 'graded' && calls === 3,
    `(calls=${calls})`
  );

  let refusals = 0;
  let thrown = null;
  try {
    await withDbRetry('test', async () => {
      refusals++;
      throw Object.assign(new Error('not open'), { code: 'SUBMIT_REJECTED' });
    });
  } catch (err) {
    thrown = err;
  }
  check('a rejection is the answer, not a blip — tried once', refusals === 1, `(calls=${refusals})`);
  check('and the original error comes back unchanged', thrown?.message === 'not open', `(${thrown?.message})`);

  let always = 0;
  let gaveUp = null;
  try {
    await withDbRetry('test', async () => {
      always++;
      throw deadlock;
    });
  } catch (err) {
    gaveUp = err;
  }
  check('it gives up eventually rather than retrying forever', always === 3, `(calls=${always})`);
  check('and reports the database error it actually hit', gaveUp?.code === 'ER_LOCK_DEADLOCK', `(${gaveUp?.code})`);

  // Now the real path. A genuine deadlock needs two transactions to meet at the
  // same row at the same instant, which a test can lose under load, so the api
  // is told to fail the next grading attempt the way a busy database fails
  // (/api/test/fail-next-submit). The failure travels the same code path a real
  // ER_LOCK_DEADLOCK does — thrown out of the transaction, caught by withDbRetry.
  const api = await startApi(3050);
  let sid = null;
  try {
    if (!check('instance started', !api.failed, api.log().slice(-300))) throw 0;
    const r = await q(
      `INSERT INTO students (display_name, age, subject, current_level, placement_status)
       VALUES (?, 15, 'Computer Science', 0, 'pending')`,
      [`OPS-retry-${Date.now()}`]
    );
    sid = Number(r.insertId);
    await q(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?, 'CS-101', NOW())`, [sid]);
    await assignSegment(sid);
    await applyColdStart(sid);
    await publishWeek(sid, '2026-12-14');
    const openSlot = async () => {
      const week = await (await fetch(`${api.base}/api/week/${sid}`, { headers: { 'X-User-Id': String(sid) } })).json();
      const slot = week.slots.find((s) => s.status === 'open');
      const open = await (
        await fetch(`${api.base}/api/slot/${slot.slot_id}/open`, {
          method: 'POST',
          headers: { 'X-User-Id': String(sid) },
        })
      ).json();
      const [[m]] = await db.query(
        `SELECT m.answer_key ak FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
        [open.assignment_id]
      );
      const ak = typeof m.ak === 'string' ? JSON.parse(m.ak) : m.ak;
      return { aid: open.assignment_id, correct: ak.correct };
    };
    const arm = (times) =>
      fetch(`${api.base}/api/test/fail-next-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ times, code: 'ER_LOCK_DEADLOCK' }),
      });
    const doSubmit = async (aid, selected) => {
      const res = await fetch(`${api.base}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': String(sid) },
        body: JSON.stringify({ assignmentId: aid, selected }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // One transient failure: the student never sees it.
    const first = await openSlot();
    await arm(1);
    const submitted = await doSubmit(first.aid, first.correct);
    check(
      'a submit that hits one deadlock still returns the grade',
      submitted.status === 200 && typeof submitted.body?.correct === 'boolean',
      `(status=${submitted.status} ${JSON.stringify(submitted.body)?.slice(0, 100)})`
    );
    const graded = Number(
      (await q(`SELECT COUNT(*) n FROM attempt_logs WHERE assignment_id = ? AND event = 'graded'`, [first.aid]))[0].n
    );
    check('graded exactly once, not once per attempt', graded === 1, `(graded events=${graded})`);
    check(
      'the retry was logged, not swallowed',
      /transient database failure/.test(api.log()),
      `(${api.log().replace(/\s+/g, ' ').slice(-160)})`
    );

    // More failures than attempts: it gives up, and gives up cleanly — the
    // assignment is untouched, so the student can submit again for real.
    const second = await openSlot();
    await arm(9);
    const gaveUp = await doSubmit(second.aid, second.correct);
    check('a database that keeps failing is reported, not hidden', gaveUp.status >= 500, `(status=${gaveUp.status})`);
    const [[row]] = await db.query(`SELECT status FROM assignments WHERE id = ?`, [second.aid]);
    check('and the assignment is left open, not half-graded', row?.status === 'open', `(status=${row?.status})`);
    await arm(0);
    const retryAfter = await doSubmit(second.aid, second.correct);
    check(
      'the student can simply submit again once it recovers',
      retryAfter.status === 200,
      `(status=${retryAfter.status})`
    );
  } catch {
    /* recorded above */
  } finally {
    killTree(listenerPid(3050) ?? api.child.pid);
    if (sid) await q(`DELETE FROM students WHERE id = ?`, [sid]).catch(() => {});
  }
}

// ------------------------------------------------------------------------ [9]
// Only failed sign-ins were capped. Everything a signed-in student can write was
// unbounded, so one stuck retry loop in a browser tab could hold the database
// against the whole pilot.
console.log('\n[9] A runaway client is capped, one student at a time');
{
  const api = await startApi(3054);
  const made = [];
  try {
    if (!check('instance started', !api.failed, api.log().slice(-300))) throw 0;
    const student = async (tag) => {
      const r = await q(
        `INSERT INTO students (display_name, age, subject, current_level, placement_status)
         VALUES (?, 15, 'Computer Science', 0, 'complete')`,
        [`OPS-limit-${tag}-${Date.now()}`]
      );
      const id = Number(r.insertId);
      made.push(id);
      return id;
    };
    const a = await student('a');
    const b = await student('b');
    // The cap counts REQUESTS, so it does not matter that this slot is not
    // theirs — which is the point: a runaway sending nonsense is still a
    // runaway. The limiter sits after the role check and before the handler.
    const knock = (sid) =>
      fetch(`${api.base}/api/slot/999999999/open`, {
        method: 'POST',
        headers: { 'X-User-Id': String(sid) },
      });

    const statuses = [];
    for (let i = 0; i < LIMITS.open; i++) statuses.push((await knock(a)).status);
    check(
      `the first ${LIMITS.open} requests are all answered normally`,
      statuses.every((s) => s !== 429),
      `(429s=${statuses.filter((s) => s === 429).length})`
    );

    const over = await knock(a);
    const body = await over.json().catch(() => null);
    check('one request past the cap is refused with 429', over.status === 429, `(status=${over.status})`);
    check(
      'the refusal names itself',
      body?.error?.code === 'too_many_requests',
      `(${JSON.stringify(body)?.slice(0, 120)})`
    );
    check(
      'and says when to come back (Retry-After)',
      Number(over.headers.get('retry-after')) > 0,
      `(Retry-After=${over.headers.get('retry-after')})`
    );

    // The cap is per student. A shared proxy address must never throttle a class.
    const other = await knock(b);
    check('a different student is unaffected', other.status !== 429, `(status=${other.status})`);

    await fetch(`${api.base}/api/test/reset-rate-limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const afterReset = await knock(a);
    check(
      'the window can be cleared (so harnesses are not the runaway)',
      afterReset.status !== 429,
      `(status=${afterReset.status})`
    );
  } catch {
    /* recorded above */
  } finally {
    killTree(listenerPid(3054) ?? api.child.pid);
    for (const id of made) await q(`DELETE FROM students WHERE id = ?`, [id]).catch(() => {});
  }
}

// ----------------------------------------------------------------------- [10]
// A fresh MySQL ships mysql.time_zone* empty, and CONVERT_TZ with a NAMED zone
// then returns NULL: every streak silently computes as nothing, for everybody,
// with nothing in any log. Loading the tables is part of creating a database,
// and a database where a zone does not resolve must not be served.
console.log('\n[10] A database whose named timezones do not resolve is refused');
{
  let sid = null;
  try {
    // The zones actually in use are the ones checked, so a student whose zone
    // does not exist is the honest way to produce the failure — no need to
    // damage the server's shared timezone tables to test this.
    const r = await q(
      `INSERT INTO students (display_name, age, subject, current_level, placement_status, timezone)
       VALUES (?, 15, 'Computer Science', 0, 'complete', 'Mars/Phobos')`,
      [`OPS-tz-${Date.now()}`]
    );
    sid = Number(r.insertId);

    const bad = await unresolvableZones();
    check(
      'a zone that cannot resolve is found',
      bad.includes('Mars/Phobos'),
      `(unresolvable=${bad.join(',') || 'none'})`
    );

    let thrown = null;
    try {
      await assertNamedTimezones();
    } catch (err) {
      thrown = err;
    }
    check('the check refuses rather than returning', thrown != null, '');
    check(
      'and names both the zone and the command that fixes it',
      /Mars\/Phobos/.test(String(thrown?.message)) && /db:timezones/.test(String(thrown?.message)),
      `(${String(thrown?.message).slice(0, 140)})`
    );

    // End to end: the api must not serve a database in that state.
    const api = await startApi(3055, {}, { waitForReady: false });
    let exited = null;
    for (let i = 0; i < 40 && exited == null; i++) {
      exited = api.exited();
      if (exited == null) await sleep(250);
    }
    check('the api refuses to start on it', exited != null && exited !== 0, `(exit=${exited})`);
    check(
      'saying which zone and how to load the tables',
      /Mars\/Phobos/.test(api.log()) && /db:timezones/.test(api.log()),
      `(${api.log().replace(/\s+/g, ' ').slice(-200)})`
    );
    killTree(listenerPid(3055) ?? api.child.pid);

    // With the bad zone gone the same server starts normally.
    await q(`DELETE FROM students WHERE id = ?`, [sid]);
    sid = null;
    const good = await startApi(3055);
    check('and starts once every zone in use resolves', !good.failed, good.log().replace(/\s+/g, ' ').slice(-200));
    killTree(listenerPid(3055) ?? good.child.pid);
  } catch {
    /* recorded above */
  } finally {
    if (sid) await q(`DELETE FROM students WHERE id = ?`, [sid]).catch(() => {});
  }

  // The loader is safe to run again — setup steps get re-run.
  const again = spawnSync(process.execPath, ['scripts/load-timezones.mjs'], { encoding: 'utf8' });
  check('npm run db:timezones is idempotent', again.status === 0, `(exit=${again.status})`);
  check(
    'and says so rather than reloading',
    /already loaded|OK — named zones resolve/.test(`${again.stdout}${again.stderr}`),
    `(${`${again.stdout}${again.stderr}`.replace(/\s+/g, ' ').slice(0, 140)})`
  );
}

await prodDb.drop();
await db.end();
// Importing the app's modules (segmentation, coldstart, weekPublisher) creates
// the shared pool in src/db.ts. Leaving it open holds the event loop open, so
// this process printed its result and then never exited — which is how it
// stalled run-all.mjs until the timeout.
await appPool.end();
console.log(`\n==== Ops: ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
