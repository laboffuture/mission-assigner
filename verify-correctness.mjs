// Phase 5 correctness harness (audit #39–#42, #46, #47, #49 and A4).
//
//   [1] A database outage is a 503 service_unavailable, not an auth failure.
//   [2] AUTH_MODE=lti (a stub) answers 401, not 500.
//   [3] An Idempotency-Key is bound to the request body: same key + different
//       body is 422, never a replay of the first answer.
//   [4] `selected` must be one of the mission's option keys (exactly).
//   [5] The /quality page is gated server-side (anonymous -> login, student ->
//       access denied, staff -> the page).
//   [6] Expected client errors are logged below ERROR; real errors stay ERROR.
//
// Needs the API on :3000 with ENABLE_TEST_HOOKS=1 (like the other harnesses);
// spawns its own short-lived API instances for [1] and [2].
// Run: npm run verify:correctness
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { useSelectionMode } from './test-support/selection-mode.mjs';
import { killTree, listenerPid, TREE_OPTS } from './test-support/proc.mjs';
import { assignSegment } from './src/segmentation.js';
import { applyColdStart } from './src/coldstart.js';
import { publishWeek } from './src/weekPublisher.js';

await useSelectionMode('legacy');

const BASE = 'http://localhost:3000';
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

async function call(method, path, { as, body, raw, headers = {}, base = BASE, redirect = 'follow' } = {}) {
  const h = { ...headers };
  if (as != null) h['X-User-Id'] = String(as);
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) h['Content-Type'] ??= 'application/json';
  const r = await fetch(base + path, { method, headers: h, body: payload, redirect });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text, headers: r.headers, reqId: r.headers.get('x-request-id') };
}
const logsFor = async (reqId, base = BASE) =>
  (await call('GET', `/api/test/logs?requestId=${reqId}`, { base })).json ?? [];
const maxLevel = (entries) => Math.max(0, ...entries.map((e) => Number(e.level) || 0));
const describe = (entries) => entries.map((e) => `${e.level}:${e.msg}`).join(', ');

async function newStudent(name) {
  const [r] = await db.query(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status) VALUES (?,15,'Computer Science',0,'pending')`,
    [name]
  );
  await db.query(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?,'CS101',NOW())`, [
    r.insertId,
  ]);
  await assignSegment(r.insertId);
  await applyColdStart(r.insertId);
  await publishWeek(r.insertId, '2026-12-07');
  return r.insertId;
}
async function openSlot1(sid) {
  const wk = (await call('GET', `/api/week/${sid}`, { as: sid })).json;
  const slot1 = wk.slots.find((s) => s.slot_index === 1);
  return (await call('POST', `/api/slot/${slot1.slot_id}/open`, { as: sid })).json.assignment_id;
}
async function keysOf(aid) {
  const [[row]] = await db.query(
    `SELECT m.answer_key ak, a.mission_id mid FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
    [aid]
  );
  const ak = typeof row.ak === 'string' ? JSON.parse(row.ak) : row.ak;
  const [opts] = await db.query(`SELECT option_key k FROM mission_options WHERE mission_id = ? ORDER BY option_key`, [
    row.mid,
  ]);
  const keys = opts.map((o) => o.k);
  return { correct: ak.correct, wrong: keys.find((k) => k !== ak.correct), keys };
}
const statusOf = async (aid) => (await db.query(`SELECT status FROM assignments WHERE id = ?`, [aid]))[0][0].status;

/** Start an API instance with env overrides; resolves once it answers. */
async function startApi(port, env) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), ENABLE_TEST_HOOKS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...TREE_OPTS,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/login`);
      if (r.status === 200)
        return { base: `http://localhost:${port}`, stop: () => killTree(listenerPid(port) ?? child.pid) };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child.pid);
  throw new Error(`API on :${port} did not start: ${log.slice(-500)}`);
}

// ------------------------------------------------------------------------ [1]
console.log('\n[1] A database outage is 503 service_unavailable — not an authentication failure');
{
  // Point an instance at a port nothing listens on: every query fails to connect.
  const api = await startApi(3031, { DB_PORT: '1', AUTH_MODE: 'dev' });
  try {
    for (const [label, method, path, opts] of [
      ['student GET /api/week', 'GET', '/api/week/1', { as: 1 }],
      ['student POST /api/submit', 'POST', '/api/submit', { as: 1, body: { assignmentId: 1, selected: 'a' } }],
    ]) {
      const r = await call(method, path, { ...opts, base: api.base });
      check(`${label}: 503`, r.status === 503, `(got ${r.status} ${r.text.slice(0, 120)})`);
      check(
        `${label}: code service_unavailable`,
        r.json?.error?.code === 'service_unavailable',
        `(code=${r.json?.error?.code})`
      );
      check(
        `${label}: message says temporarily unavailable, not authentication`,
        /temporarily unavailable/i.test(r.json?.error?.message ?? '') && !/auth/i.test(r.json?.error?.message ?? ''),
        `(message="${r.json?.error?.message}")`
      );
      const logs = await logsFor(r.reqId, api.base);
      check(
        `${label}: logged as a database error, not an authentication error`,
        logs.some((e) => e.level >= 50 && /database/i.test(e.msg)) && !logs.some((e) => /authentication/i.test(e.msg)),
        `(${describe(logs)})`
      );
    }
    const anon = await call('GET', '/api/week/1', { base: api.base });
    check('no credentials during an outage is still 401', anon.status === 401, `(got ${anon.status})`);
    const quality = await call('GET', '/quality', { as: 1, base: api.base, redirect: 'manual' });
    check('/quality during an outage is 503', quality.status === 503, `(got ${quality.status})`);
  } finally {
    api.stop();
  }
}

// ------------------------------------------------------------------------ [2]
console.log('\n[2] AUTH_MODE=lti (stub provider) answers 401, not 500');
{
  const api = await startApi(3032, { AUTH_MODE: 'lti' });
  try {
    for (const [label, opts] of [
      ['no credentials', {}],
      ['a dev X-User-Id header (ignored in lti mode)', { as: 1 }],
    ]) {
      const r = await call('GET', '/api/week/1', { ...opts, base: api.base });
      check(`${label}: 401`, r.status === 401, `(got ${r.status} ${r.text.slice(0, 120)})`);
      check(
        `${label}: code unauthenticated`,
        r.json?.error?.code === 'unauthenticated',
        `(code=${r.json?.error?.code})`
      );
      const logs = await logsFor(r.reqId, api.base);
      check(`${label}: nothing logged at ERROR`, maxLevel(logs) < 50, `(${describe(logs)})`);
    }
  } finally {
    api.stop();
  }
}

// ------------------------------------------------------------------------ [3]
console.log('\n[3] An Idempotency-Key is bound to the request body');
{
  const sid = await newStudent('Idem Body');
  const aid = await openSlot1(sid);
  const k = await keysOf(aid);
  const key = `idem-body-${Date.now()}`;
  const H = { 'Idempotency-Key': key };
  const first = await call('POST', '/api/submit', {
    as: sid,
    headers: H,
    body: { assignmentId: aid, selected: k.correct },
  });
  check('first submit 200', first.status === 200, `(got ${first.status})`);
  const same = await call('POST', '/api/submit', {
    as: sid,
    headers: H,
    body: { assignmentId: aid, selected: k.correct },
  });
  check(
    'same key + same body replays the stored result',
    same.status === 200 && same.json?.idempotent_replay === true,
    `(got ${same.status})`
  );
  const reordered = await call('POST', '/api/submit', {
    as: sid,
    headers: H,
    raw: `{"selected":${JSON.stringify(k.correct)},"assignmentId":${aid}}`,
  });
  check(
    'same body with keys in another order is the same body',
    reordered.status === 200 && reordered.json?.idempotent_replay === true,
    `(got ${reordered.status})`
  );
  const diff = await call('POST', '/api/submit', {
    as: sid,
    headers: H,
    body: { assignmentId: aid, selected: k.wrong },
  });
  check('same key + different body -> 422', diff.status === 422, `(got ${diff.status} ${diff.text.slice(0, 160)})`);
  check(
    '  ...with code idempotency_key_reused',
    diff.json?.error?.code === 'idempotency_key_reused',
    `(code=${diff.json?.error?.code})`
  );
  check('  ...and never a replay presented as this answer', diff.json?.correct === undefined);
  const [[{ n }]] = await db.query(
    `SELECT COUNT(*) n FROM xp_events WHERE assignment_id = ? AND event_type = 'submit'`,
    [aid]
  );
  check('graded exactly once', Number(n) === 1, `(submit xp events=${n})`);
}

// ------------------------------------------------------------------------ [4]
console.log("\n[4] `selected` must be one of the mission's option keys");
{
  const sid = await newStudent('Answer Check');
  const aid = await openSlot1(sid);
  const k = await keysOf(aid);
  for (const [label, selected] of [
    ['a key the mission does not have', 'z'],
    ['an option key in the wrong case', k.correct.toUpperCase()],
    ['a valid key plus extra characters', `${k.correct}x`],
    ['free text', 'the second one'],
  ]) {
    const r = await call('POST', '/api/submit', { as: sid, body: { assignmentId: aid, selected } });
    check(`${label} ("${selected}") -> 400`, r.status === 400, `(got ${r.status} ${r.text.slice(0, 120)})`);
    check(`  ...code invalid_answer`, r.json?.error?.code === 'invalid_answer', `(code=${r.json?.error?.code})`);
  }
  check('assignment still open after the rejections (nothing stored)', (await statusOf(aid)) === 'open');
  const [[{ n }]] = await db.query(
    `SELECT COUNT(*) n FROM attempt_logs WHERE assignment_id = ? AND event = 'submitted'`,
    [aid]
  );
  check('no submission recorded for a rejected answer', Number(n) === 0, `(submitted logs=${n})`);
  const ok = await call('POST', '/api/submit', { as: sid, body: { assignmentId: aid, selected: k.wrong } });
  check(
    `a real option key ("${k.wrong}") is accepted and graded`,
    ok.status === 200 && ok.json?.correct === false,
    `(got ${ok.status})`
  );
}

// ------------------------------------------------------------------------ [5]
console.log('\n[5] The /quality page is gated server-side');
{
  const SHELL = 'Mission Hub — Quality';
  const anon = await call('GET', '/quality', { redirect: 'manual' });
  check('anonymous -> 302', anon.status === 302, `(got ${anon.status})`);
  check(
    '  ...to /login',
    /\/login$/.test(anon.headers.get('location') ?? ''),
    `(location=${anon.headers.get('location')})`
  );
  check('  ...without the page', !anon.text.includes(SHELL));
  const stu = await call('GET', '/quality', { as: 1, redirect: 'manual' });
  check('student -> 403', stu.status === 403, `(got ${stu.status})`);
  check(
    '  ...an HTML "access denied" page',
    /text\/html/.test(stu.headers.get('content-type') ?? '') && /access denied/i.test(stu.text),
    `(${stu.headers.get('content-type')})`
  );
  check('  ...without the page', !stu.text.includes(SHELL));
  const [[sme]] = await db.query(`SELECT id FROM students WHERE role = 'sme' ORDER BY id LIMIT 1`);
  const staff = await call('GET', '/quality', { as: sme.id, redirect: 'manual' });
  check('SME -> 200 with the page', staff.status === 200 && staff.text.includes(SHELL), `(got ${staff.status})`);
  const [[inst]] = await db.query(`SELECT id FROM students WHERE role = 'instructor' ORDER BY id LIMIT 1`);
  if (inst) {
    const r = await call('GET', '/quality', { as: inst.id, redirect: 'manual' });
    check('instructor (no access to the report data) -> 403', r.status === 403, `(got ${r.status})`);
  }
}

// ------------------------------------------------------------------------ [6]
console.log('\n[6] Expected client errors are logged below ERROR; real errors stay at ERROR');
{
  const cases = [
    ['malformed JSON', () => call('POST', '/api/submit', { as: 1, raw: '{"assignmentId": 1,' }), 400],
    [
      'a body over the size limit (413)',
      () => call('POST', '/api/submit', { as: 1, raw: JSON.stringify({ pad: 'x'.repeat(200_000) }) }),
      413,
    ],
  ];
  const sid = await newStudent('Log Levels');
  const aid = await openSlot1(sid);
  const k = await keysOf(aid);
  await call('POST', '/api/submit', { as: sid, body: { assignmentId: aid, selected: k.correct } });
  cases.push([
    'submitting an assignment that is not open',
    () => call('POST', '/api/submit', { as: sid, body: { assignmentId: aid, selected: k.correct } }),
    400,
  ]);
  const sid2 = await newStudent('Log Levels 2');
  const aid2 = await openSlot1(sid2);
  cases.push([
    'an invalid answer',
    () => call('POST', '/api/submit', { as: sid2, body: { assignmentId: aid2, selected: 'z' } }),
    400,
  ]);
  for (const [label, run, status] of cases) {
    const r = await run();
    check(`${label}: ${status}`, r.status === status, `(got ${r.status})`);
    const logs = await logsFor(r.reqId);
    check(`${label}: nothing logged at ERROR`, maxLevel(logs) < 50, `(${describe(logs)})`);
  }
  const boom = await call('GET', '/api/test/boom');
  const logs = await logsFor(boom.reqId);
  check(
    'control — a real server error is still logged at ERROR',
    boom.status === 500 && maxLevel(logs) >= 50,
    `(${describe(logs)})`
  );
}

await db.end();
console.log(`\n==== Correctness: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
