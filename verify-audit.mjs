// Audit harness — the 62 cases from the full project audit (Part 4).
//
// Each case prints its EXPECTED result before it runs, then records one of three
// states: VERIFIED (ran and passed), FAILED (ran and a sub-check failed), or
// NOT TESTED (could not be run — the reason is recorded). Nothing is inferred
// from reading code: every state comes from something this harness executed.
//
// Requires (same as verify:all):
//   - MySQL up and migrated
//   - the API on :3000 started with ENABLE_TEST_HOOKS=1
//   - the web app on :3001 (sections 4.7 and 4.9 drive a real browser)
//   - pipeline/.venv (section 4.10)
//
// It is DESTRUCTIVE to the dev database: it reseeds at start and end, stops and
// restarts MySQL (4.7), and spawns extra API instances on ports 3012-3016.
//
// Run:  npx tsx verify-audit.mjs                 (all sections)
//       npx tsx verify-audit.mjs --only=4.1,4.5  (selected sections)
// A JSON copy of the results is written to the OS temp dir; its path is printed.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { WIN, listenerPid, killTree, processAlive, TREE_OPTS } from './test-support/proc.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildUmzug, makePool } from './src/migrator.js';

process.env.ENABLE_TEST_HOOKS ||= '1'; // in-process modules only; spawned servers decide their own

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const DB_NAME = process.env.DB_NAME ?? 'mission_demo';
const DBPASS = process.env.DB_PASS ?? 'devpass';
const MYSQL_HOME =
  process.env.MYSQL_HOME ?? join(process.env.LOCALAPPDATA ?? 'C:/Users/Default/AppData/Local', 'mission-mysql');
const MYSQL_BIN = join(MYSQL_HOME, 'mysql-8.4.11-winx64', 'bin');
// The mysql client for case 45's restore: the portable install on Windows,
// `mysql` on PATH elsewhere (CI), or MYSQL_CLIENT when set.
const MYSQL_CLIENT = process.env.MYSQL_CLIENT ?? (WIN ? join(MYSQL_BIN, 'mysql.exe') : 'mysql');
const VENV_PY = [join(ROOT, 'pipeline/.venv/Scripts/python.exe'), join(ROOT, 'pipeline/.venv/bin/python')].find(
  existsSync
);

const { pool } = await import('./src/db.js');
const cfg = await import('./src/config.js');
const cur = await import('./src/curriculum.js');
const sel = await import('./src/selection.js');
const { fillSlot } = await import('./src/slotFiller.js');
const { publishWeek } = await import('./src/weekPublisher.js');
const { assignSegment } = await import('./src/segmentation.js');
const { applyColdStart } = await import('./src/coldstart.js');
const { computeStreak, computeLongestStreak } = await import('./src/streaks.js');

// ---------------------------------------------------------------- results --
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
// --shuffle runs the cases in a random order (--shuffle=<seed> replays one).
// A case that only passes in file order is depending on another case, which is
// a bug in the case, not a property of the system.
const SHUFFLE_ARG = process.argv.find((a) => a === '--shuffle' || a.startsWith('--shuffle='));
const SHUFFLE_SEED = SHUFFLE_ARG ? Number(SHUFFLE_ARG.split('=')[1] ?? Date.now() % 2147483647) || 1 : null;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one audit case. `expected` is printed BEFORE the body runs. A case with no
 * failing sub-check is VERIFIED; any failing sub-check makes it FAILED; calling
 * c.notTested(reason) makes it NOT TESTED regardless of sub-checks.
 */
/**
 * Cases are REGISTERED here and executed later, so their order is data rather
 * than the order of statements in this file. Every case declares the runtime
 * state it needs (selection mode, feedback gating, curriculum config); the
 * runner applies that state fresh before each one. That is what makes the
 * suite order-independent: nothing is inherited from whatever ran before, so
 * `--shuffle` is a fair test rather than a lottery.
 */
const CASES = [];
function runCase(section, id, title, expected, fn, state = {}) {
  CASES.push({ section, id, title, expected, fn, state });
}

async function execCase({ section, id, title, expected, fn }) {
  void section;
  console.log(`\n[${id}] ${title}\n    EXPECTED: ${expected}`);
  const c = {
    checks: [],
    notes: [],
    nt: null,
    check(name, cond, detail = '') {
      const ok = !!cond;
      this.checks.push({ name, ok, detail: String(detail) });
      console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
      return ok;
    },
    note(s) {
      this.notes.push(s);
      console.log(`    NOTE ${s}`);
    },
    notTested(why) {
      this.nt = why;
      console.log(`    NOT TESTED: ${why}`);
    },
  };
  try {
    await fn(c);
  } catch (e) {
    const msg = String(e?.stack ?? e)
      .split('\n')
      .slice(0, 5)
      .join(' | ');
    c.checks.push({ name: 'case threw an exception', ok: false, detail: msg });
    console.log(`    FAIL case threw: ${msg}`);
  }
  let state = c.nt ? 'NOT TESTED' : c.checks.length && c.checks.every((x) => x.ok) ? 'VERIFIED' : 'FAILED';
  if (!c.nt && c.checks.length === 0) {
    state = 'FAILED';
    c.checks.push({ name: 'no checks ran', ok: false, detail: '' });
  }
  results.push({ section, id, title, expected, state, checks: c.checks, notes: c.notes, why: c.nt });
  console.log(`    => ${state}`);
}

// ------------------------------------------------------------------- HTTP --
async function api(method, path, { as, body, headers = {}, base = BASE, rawBody } = {}) {
  const h = { ...headers };
  if (as != null) h['X-User-Id'] = String(as);
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    h['Content-Type'] ??= 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(base + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    return {
      status: 0,
      json: null,
      text: String(e?.cause?.code ?? e?.message ?? e),
      headers: new Headers(),
      ms: Date.now() - t0,
    };
  }
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text, headers: r.headers, ms: Date.now() - t0 };
}
const hook = (name, body) => api('POST', `/api/test/${name}`, { body });
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

async function staffLogin(username, password = 'changeme', base = BASE) {
  const r = await api('POST', '/api/login', { body: { username, password }, base });
  return { status: r.status, cookie: cookieOf(r), json: r.json, res: r };
}

/** A body looks like it leaked internals if it carries a stack frame or a raw DB error. */
const LEAK_RE =
  /(\n\s+at |sqlMessage|ER_[A-Z_]{3,}|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|<!DOCTYPE html>[\s\S]*Error|node_modules[\\/])/;

// --------------------------------------------------------------------- DB --
const db = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  user: process.env.DB_USER ?? 'root',
  password: DBPASS,
  database: DB_NAME,
  multipleStatements: true,
  connectionLimit: 4,
});
const q = async (sql, params = []) => (await db.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

let xpRules = [];
async function loadXpRules() {
  xpRules = await q(`SELECT event_type, difficulty, points FROM xp_rules WHERE active = 1`);
}
/** Mirror of xp.ts rule resolution: exact difficulty first, then the NULL rule. */
function xpFor(event, difficulty) {
  const exact = xpRules.find(
    (r) => r.event_type === event && r.difficulty != null && Number(r.difficulty) === difficulty
  );
  const fallback = xpRules.find((r) => r.event_type === event && r.difficulty == null);
  return Number((exact ?? fallback)?.points ?? 0);
}

async function reseed() {
  const r = spawnSync('npm', ['run', 'db:seed'], { cwd: ROOT, shell: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`db:seed failed: ${(r.stdout + r.stderr).slice(-400)}`);
}

// --------------------------------------------------------------- fixtures --
// Browser-driven cases (43, 49-55) use SEEDED students (ids 1, 2, 3). When the
// audit was written, the web tier corrupted base64-padded session cookies and
// bounced students of most id lengths to /login (case 7), so these cases used
// ids that happened to work, to measure the screens rather than that bug. The
// bug is fixed (raw cookie forwarding, Phase 2) and the e2e journeys now run
// across ids of every length; these cases keep the seeded students so their
// fixtures stay stable.
const UI_STUDENT = 1;
const KBD_STUDENT = 2;
const DBDOWN_STUDENT = 3;
let seq = 0;
async function newCsStudent(tag, { age = 15, courses = ['CS-101'], level } = {}) {
  const r = await q(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status)
     VALUES (?, ?, 'Computer Science', 0, 'pending')`,
    [`AUD-${tag}-${++seq}`, age]
  );
  const id = Number(r.insertId);
  for (const c of courses)
    await q(`INSERT INTO student_courses (student_id, course_ref, completed_at) VALUES (?, ?, NOW())`, [id, c]);
  await assignSegment(id);
  await applyColdStart(id);
  if (level != null) await q(`UPDATE students SET current_level = ? WHERE id = ?`, [level, id]);
  return id;
}

let trackId = null;
async function newRoboticsStudent(tag, level, pos) {
  const r = await q(
    `INSERT INTO students (display_name, age, subject, current_level, placement_status)
     VALUES (?, 14, 'Robotics', ?, 'complete')`,
    [`AUD-${tag}-${++seq}`, level]
  );
  const id = Number(r.insertId);
  if (pos) await cur.setPosition(id, trackId, await cur.findSession(trackId, ...pos), 'explicit');
  return id;
}

/** This week's Monday in Asia/Kolkata — the week the API serves. */
async function currentMonday() {
  const r = await one(
    `SELECT DATE_FORMAT(DATE_SUB(d, INTERVAL WEEKDAY(d) DAY), '%Y-%m-%d') m
       FROM (SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'Asia/Kolkata')) d) x`
  );
  return r.m;
}

/** GET the student's week, publishing it first if the API does not. */
async function weekOf(sid) {
  let r = await api('GET', `/api/week/${sid}`, { as: sid });
  if (r.status !== 200 || !r.json?.slots?.length) {
    await publishWeek(sid, await currentMonday());
    r = await api('GET', `/api/week/${sid}`, { as: sid });
  }
  return r.json;
}
const slotByIndex = (week, i) => week.slots.find((s) => s.slot_index === i);
const openSlot = (sid, slotId) => api('POST', `/api/slot/${slotId}/open`, { as: sid });
async function answerKey(aid) {
  const row = await one(
    `SELECT m.answer_key ak, m.difficulty d, m.id mid FROM assignments a JOIN missions m ON m.id = a.mission_id WHERE a.id = ?`,
    [aid]
  );
  return { correct: parse(row.ak).correct, difficulty: Number(row.d), missionId: Number(row.mid) };
}
const wrongOf = (c) => ['a', 'b', 'c', 'd'].find((x) => x !== c);
const submit = (sid, aid, selected, key) =>
  api('POST', '/api/submit', {
    as: sid,
    body: { assignmentId: aid, selected },
    headers: key ? { 'Idempotency-Key': key } : {},
  });
const VALID_FEEDBACK = [
  { question_key: 'perceived_difficulty', value: 'About right' },
  { question_key: 'time_taken', value: 'About as expected' },
  { question_key: 'clarity', value: '4' },
  { question_key: 'confidence', value: '4' },
];
const feedback = (sid, aid, answers = VALID_FEEDBACK) =>
  api('POST', `/api/feedback/${aid}`, { as: sid, body: { answers } });
const studentRow = (sid) =>
  one(`SELECT current_level lvl, stall_count stall, total_xp xp FROM students WHERE id = ?`, [sid]).then((r) => ({
    lvl: Number(r.lvl),
    stall: Number(r.stall),
    xp: Number(r.xp),
  }));

/** Open + grade one slot. Returns the assignment id and the submit response. */
async function completeSlot(sid, slotId, correct, { fb = true } = {}) {
  const o = await openSlot(sid, slotId);
  const aid = o.json?.assignment_id;
  if (!aid) return { o, aid: null };
  const k = await answerKey(aid);
  const s = await submit(sid, aid, correct ? k.correct : wrongOf(k.correct));
  const f = fb ? await feedback(sid, aid) : null;
  return { o, aid, k, s, f };
}

// --------------------------------------------------- process control -------
// listenerPid / killTree / processAlive come from test-support/proc.mjs, which
// works on Windows (netstat/taskkill) and POSIX (lsof/process groups) alike.

/** Start a real API instance with an env override. Always started fresh; killed by tree. */
async function spawnApi(port, overrides = {}) {
  const stale = listenerPid(port);
  if (stale) killTree(stale);
  const env = { ...process.env, PORT: String(port), ...overrides };
  if (!('ENABLE_TEST_HOOKS' in overrides)) delete env.ENABLE_TEST_HOOKS;
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...TREE_OPTS,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) break;
    try {
      const r = await fetch(`${base}/login`, { signal: AbortSignal.timeout(2000) });
      if (r.status) return { child, base, port, log: () => log, ok: true };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return { child, base, port, log: () => log, ok: false };
}
function stopApi(inst) {
  if (!inst?.child) return;
  killTree(inst.child.pid);
  const left = listenerPid(inst.port);
  if (left) killTree(left);
}

async function mysqlUp() {
  try {
    const c = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: DBPASS, connectTimeout: 2000 });
    await c.query('SELECT 1');
    await c.end();
    return true;
  } catch {
    return false;
  }
}
/**
 * Graceful shutdown, then wait for the mysqld PROCESS to exit — not just for the
 * port to close. mysqld stops accepting connections early in shutdown but keeps
 * its InnoDB/data-dictionary lock until it has flushed; starting a new one before
 * then makes the new one abort ("Data Dictionary initialization failed").
 */
async function stopMysql() {
  // CI: AUDIT_MYSQL_STOP_CMD (e.g. `docker stop <service container>`), which only
  // returns once the server has exited.
  if (process.env.AUDIT_MYSQL_STOP_CMD) {
    const r = spawnSync(process.env.AUDIT_MYSQL_STOP_CMD, { shell: true, encoding: 'utf8' });
    for (let i = 0; i < 120 && (await mysqlUp()); i++) await sleep(250);
    return r;
  }
  const pid = listenerPid(3306);
  const r = spawnSync(
    join(MYSQL_BIN, WIN ? 'mysqladmin.exe' : 'mysqladmin'),
    ['-uroot', `-p${DBPASS}`, '--host=127.0.0.1', 'shutdown'],
    { encoding: 'utf8' }
  );
  for (let i = 0; pid && i < 120 && processAlive(pid); i++) await sleep(250);
  return r;
}
async function startMysql() {
  if (process.env.AUDIT_MYSQL_START_CMD) {
    spawnSync(process.env.AUDIT_MYSQL_START_CMD, { shell: true, encoding: 'utf8' });
  } else {
    const child = spawn(
      join(MYSQL_BIN, WIN ? 'mysqld.exe' : 'mysqld'),
      [`--defaults-file=${join(MYSQL_HOME, 'my.ini')}`],
      {
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();
  }
  for (let i = 0; i < 120; i++) {
    if (await mysqlUp()) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------- browser --
let pw = null;
async function browser() {
  if (pw) return pw;
  const { chromium } = await import('./web/node_modules/playwright-core/index.mjs');
  const axeMod = await import('./web/node_modules/@axe-core/playwright/dist/index.mjs');
  const AxeBuilder = axeMod.default ?? axeMod.AxeBuilder;
  const b = await chromium.launch();
  pw = { b, AxeBuilder };
  return pw;
}
async function studentPage(sid, { theme = 'nebula', width = 1280 } = {}) {
  const { b } = await browser();
  const ctx = await b.newContext({ baseURL: WEB, viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  if (sid != null) {
    const r = await page.request.post('/api/dev/login-as', { data: { studentId: sid } });
    if (!r.ok()) throw new Error(`login-as ${sid} -> ${r.status()}`);
  }
  // Switch theme the way the LMS will: ?theme= on a real navigation, which the
  // app stores in a cookie and renders server-side from then on. (This used to
  // set data-lof-theme from an init script because ?theme= did not exist.)
  if (theme !== 'nebula') await page.goto(`/login?theme=${theme}`);
  return { ctx, page, errors };
}

/**
 * The state every case starts from, plus its own overrides. Applied to BOTH the
 * harness process (cfg.*, used by the cases that call selection directly) and
 * the running API (the /api/test hooks), because a case can exercise either.
 */
const BASE_STATE = {
  mode: 'legacy',
  gating: true,
  curriculum: { poolLookbackSessions: 0, percentScope: 'credit', revisionMixPercent: 20 },
};
async function applyState(state = {}) {
  const mode = state.mode ?? BASE_STATE.mode;
  const gating = state.gating ?? BASE_STATE.gating;
  const curriculum = { ...BASE_STATE.curriculum, ...(state.curriculum ?? {}) };
  cfg.setSelectionMode(mode);
  cfg.setPoolLookbackSessions(curriculum.poolLookbackSessions);
  cfg.setPercentScope(curriculum.percentScope);
  cfg.setRevisionMixPercent(curriculum.revisionMixPercent);
  await hook('selection-mode', { mode });
  await hook('feedback-gating', { enabled: gating });
  await hook('curriculum-config', curriculum);
}

/** Deterministic shuffle, so a failing order can be replayed: --shuffle=<seed>. */
function shuffled(list, seed) {
  let x = seed >>> 0 || 1;
  const rand = () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 4294967296);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============================================================ THE CASES ==
console.log('Mission Hub audit harness');
if (!ONLY.length || !ONLY.every((s) => ['4.10'].includes(s))) await reseed();
await loadXpRules();
trackId = await cur.findTrack('Robotics', "Tesla's Track");

// ============================================== 4.1 Student journey ==
/**
 * A student who has completed an entire week. Case 1 walks the week check by
 * check and records the student here; case 8 needs the same end state but must
 * not depend on case 1 having run first, so it builds its own when this is
 * empty. Either way it is built at most once per run.
 */
let fullWeekStudent = null;
/**
 * The newest assistance event, raised the real way (a student stalls three
 * times) when the database has none. Cases that act on an event used to take
 * whatever an earlier case had left behind — case 35 failed under --shuffle
 * because it ran before anything had raised one.
 */
async function ensureAssistanceEvent() {
  const existing = (await one(`SELECT id FROM assistance_events ORDER BY id DESC LIMIT 1`))?.id;
  if (existing) return Number(existing);
  await hook('feedback-gating', { enabled: false });
  const sid = await newCsStudent('assist-fixture');
  for (let i = 1; i <= 3; i++) {
    const w = await weekOf(sid);
    await completeSlot(sid, slotByIndex(w, i).slot_id, false, { fb: false });
  }
  await hook('feedback-gating', { enabled: true });
  const row = await one(`SELECT id FROM assistance_events WHERE student_id = ? ORDER BY id DESC LIMIT 1`, [sid]);
  return row ? Number(row.id) : null;
}

async function completedWeekStudent() {
  if (fullWeekStudent) return fullWeekStudent;
  const sid = await newCsStudent('journey-fixture');
  let week = await weekOf(sid);
  const order = [
    ...week.slots
      .filter((s) => !s.is_weekly)
      .map((s) => s.slot_index)
      .sort((a, b) => a - b),
    ...week.slots.filter((s) => s.is_weekly).map((s) => s.slot_index),
  ];
  for (const idx of order) {
    week = await weekOf(sid);
    const slot = slotByIndex(week, idx);
    if (!slot || slot.status !== 'open') continue;
    await completeSlot(sid, slot.slot_id, true);
  }
  fullWeekStudent = sid;
  return sid;
}

await runCase(
  '4.1',
  1,
  'Brand-new student completes a full week in order, with feedback after each',
  'All 8 slots (7 daily in order, then the weekly) open with a mission. Each correct answer raises the level by exactly 1 until the segment max (4), then holds. total_xp rises by exactly attempt + submit + correct(difficulty) per xp_rules at submit, then +feedback. With feedback gating on, the next daily slot stays LOCKED after submit and OPENS only after feedback. At the end all 8 assignments are graded.',
  async (c) => {
    const sid = await newCsStudent('journey');
    fullWeekStudent = sid;
    const seg = await one(
      `SELECT seg.max_level mx FROM students s JOIN segments seg ON seg.id = s.segment_id WHERE s.id = ?`,
      [sid]
    );
    const max = Number(seg.mx);
    let week = await weekOf(sid);
    const order = [
      ...week.slots
        .filter((s) => !s.is_weekly)
        .map((s) => s.slot_index)
        .sort((a, b) => a - b),
      ...week.slots.filter((s) => s.is_weekly).map((s) => s.slot_index),
    ];
    c.check(
      'week has 8 slots (7 daily + 1 weekly)',
      week.slots.length === 8 && order.length === 8,
      `(slots=${week.slots.length}, weekly=${week.slots.filter((s) => s.is_weekly).length})`
    );
    for (let n = 0; n < order.length; n++) {
      const idx = order[n];
      week = await weekOf(sid);
      const slot = slotByIndex(week, idx);
      c.check(`slot ${idx} is open when its turn comes`, slot.status === 'open', `(status=${slot.status})`);
      const before = await studentRow(sid);
      const o = await openSlot(sid, slot.slot_id);
      const aid = o.json?.assignment_id;
      if (
        !c.check(
          `slot ${idx} opens with a mission`,
          aid && Array.isArray(o.json.options),
          `(status=${o.status} body=${o.text.slice(0, 120)})`
        )
      )
        continue;
      const k = await answerKey(aid);
      const s = await submit(sid, aid, k.correct);
      const after = await studentRow(sid);
      const expLvl = Math.min(before.lvl + 1, max);
      c.check(
        `slot ${idx}: level ${before.lvl} -> ${expLvl}`,
        s.json?.level?.to === expLvl && after.lvl === expLvl,
        `(api to=${s.json?.level?.to}, db=${after.lvl})`
      );
      const expXp =
        before.xp + xpFor('attempt', k.difficulty) + xpFor('submit', k.difficulty) + xpFor('correct', k.difficulty);
      c.check(
        `slot ${idx}: XP after submit = ${expXp}`,
        after.xp === expXp && s.json?.xp?.total_xp === expXp,
        `(db=${after.xp}, api=${s.json?.xp?.total_xp}, d=${k.difficulty})`
      );
      const nextDaily = !slot.is_weekly ? order.find((i, j) => j > n && !slotByIndex(week, i).is_weekly) : undefined;
      if (nextDaily) {
        const w1 = await weekOf(sid);
        c.check(
          `slot ${nextDaily} still locked after submit, before feedback`,
          slotByIndex(w1, nextDaily).status === 'locked',
          `(status=${slotByIndex(w1, nextDaily).status})`
        );
      }
      const f = await feedback(sid, aid);
      c.check(`slot ${idx}: feedback accepted`, f.status === 200, `(status=${f.status} ${f.text.slice(0, 100)})`);
      const afterFb = await studentRow(sid);
      c.check(
        `slot ${idx}: XP after feedback = ${expXp + xpFor('feedback', k.difficulty)}`,
        afterFb.xp === expXp + xpFor('feedback', k.difficulty),
        `(db=${afterFb.xp})`
      );
      if (nextDaily) {
        const w2 = await weekOf(sid);
        c.check(
          `slot ${nextDaily} open after feedback`,
          slotByIndex(w2, nextDaily).status === 'open',
          `(status=${slotByIndex(w2, nextDaily).status})`
        );
      }
    }
    const graded = await one(`SELECT COUNT(*) n FROM assignments WHERE student_id = ? AND status = 'graded'`, [sid]);
    c.check('all 8 assignments graded', Number(graded.n) === 8, `(graded=${graded.n})`);
  }
);

await runCase(
  '4.1',
  2,
  'A student answers every mission wrong for a full week',
  'Level never changes (never drops). stall_count after n wrong answers is n mod 3. Exactly one assistance event is raised on the 3rd wrong answer and one more on the 6th — none on any other. Every one of the 8 slots still opens with a mission.',
  async (c) => {
    const sid = await newCsStudent('allwrong');
    const start = (await studentRow(sid)).lvl;
    let week = await weekOf(sid);
    const order = [...week.slots.filter((s) => !s.is_weekly), ...week.slots.filter((s) => s.is_weekly)].map(
      (s) => s.slot_index
    );
    let n = 0;
    for (const idx of order) {
      week = await weekOf(sid);
      const r = await completeSlot(sid, slotByIndex(week, idx).slot_id, false);
      if (!c.check(`slot ${idx} opens with a mission`, !!r.aid, `(${r.o.status} ${r.o.text.slice(0, 100)})`)) break;
      n++;
      const st = await studentRow(sid);
      const ev = await one(`SELECT COUNT(*) n FROM assistance_events WHERE student_id = ?`, [sid]);
      c.check(`after wrong #${n}: level still ${start}`, st.lvl === start, `(level=${st.lvl})`);
      c.check(`after wrong #${n}: stall_count = ${n % 3}`, st.stall === n % 3, `(stall=${st.stall})`);
      c.check(
        `after wrong #${n}: assistance events = ${Math.floor(n / 3)}`,
        Number(ev.n) === Math.floor(n / 3),
        `(events=${ev.n})`
      );
    }
    c.check('all 8 slots were served', n === 8, `(served=${n})`);
  }
);

await runCase(
  '4.1',
  3,
  'A student answers every mission right',
  'Level rises by 1 per correct answer until the ceiling (segment max_level = 4), then stays at 4 — never above it — and each capped answer still records a level_event with to_level 4.',
  async (c) => {
    const sid = await newCsStudent('allright', { courses: ['CS-101', 'CS-201'] });
    const max = Number(
      (
        await one(`SELECT seg.max_level mx FROM students s JOIN segments seg ON seg.id = s.segment_id WHERE s.id = ?`, [
          sid,
        ])
      ).mx
    );
    let week = await weekOf(sid);
    let peak = 0;
    for (const s of [...week.slots.filter((x) => !x.is_weekly), ...week.slots.filter((x) => x.is_weekly)]) {
      week = await weekOf(sid);
      const before = (await studentRow(sid)).lvl;
      const r = await completeSlot(sid, slotByIndex(week, s.slot_index).slot_id, true);
      if (!c.check(`slot ${s.slot_index} opens with a mission`, !!r.aid, `(${r.o.status} ${r.o.text.slice(0, 100)})`))
        break;
      const after = (await studentRow(sid)).lvl;
      peak = Math.max(peak, after);
      c.check(
        `slot ${s.slot_index}: ${before} -> ${Math.min(before + 1, max)}`,
        after === Math.min(before + 1, max),
        `(got ${after})`
      );
    }
    c.check(`level reached the ceiling ${max}`, peak === max, `(peak=${peak})`);
    const over = await one(`SELECT COUNT(*) n FROM level_events WHERE student_id = ? AND to_level > ?`, [sid, max]);
    c.check('no level_event ever exceeds the ceiling', Number(over.n) === 0, `(over=${over.n})`);
  }
);

await runCase(
  '4.1',
  4,
  'Alternating right and wrong across a week',
  'After every correct answer stall_count is 0; after every wrong answer it is 1 (it never reaches 2, because each correct answer resets it). No assistance event is raised. Level rises only on correct answers.',
  async (c) => {
    const sid = await newCsStudent('alternate');
    let week = await weekOf(sid);
    let right = true;
    for (const s of [...week.slots.filter((x) => !x.is_weekly), ...week.slots.filter((x) => x.is_weekly)]) {
      week = await weekOf(sid);
      const before = (await studentRow(sid)).lvl;
      const r = await completeSlot(sid, slotByIndex(week, s.slot_index).slot_id, right);
      if (!c.check(`slot ${s.slot_index} opens`, !!r.aid)) break;
      const st = await studentRow(sid);
      c.check(
        `slot ${s.slot_index} (${right ? 'right' : 'wrong'}): stall_count = ${right ? 0 : 1}`,
        st.stall === (right ? 0 : 1),
        `(stall=${st.stall})`
      );
      c.check(
        `slot ${s.slot_index}: level ${right ? 'rises' : 'holds'}`,
        right ? st.lvl === Math.min(before + 1, 4) : st.lvl === before,
        `(${before} -> ${st.lvl})`
      );
      right = !right;
    }
    const ev = await one(`SELECT COUNT(*) n FROM assistance_events WHERE student_id = ?`, [sid]);
    c.check('no assistance event raised', Number(ev.n) === 0, `(events=${ev.n})`);
  }
);

await runCase(
  '4.1',
  5,
  'A student abandons a mission mid-way and returns a day later',
  'After backdating the open by 24h, the slot is still open, still bound to the SAME assignment and mission; reopening returns identical content and does not award attempt XP again; the submit then succeeds and time_to_submit_seconds reflects the full ~24h gap.',
  async (c) => {
    const sid = await newCsStudent('abandon');
    const week = await weekOf(sid);
    const slot = slotByIndex(week, 1);
    const o1 = await openSlot(sid, slot.slot_id);
    const aid = o1.json.assignment_id;
    const xp1 = (await studentRow(sid)).xp;
    await q(
      `UPDATE assignments SET opened_at = opened_at - INTERVAL 1 DAY, assigned_at = assigned_at - INTERVAL 1 DAY WHERE id = ?`,
      [aid]
    );
    await q(`UPDATE attempt_logs SET created_at = created_at - INTERVAL 1 DAY WHERE assignment_id = ?`, [aid]);
    const w2 = await weekOf(sid);
    const s2 = slotByIndex(w2, 1);
    c.check('slot still open a day later', s2.status === 'open', `(status=${s2.status})`);
    c.check(
      'slot still bound to the same assignment',
      Number(s2.assignment_id) === Number(aid),
      `(${s2.assignment_id} vs ${aid})`
    );
    const o2 = await openSlot(sid, slot.slot_id);
    c.check('reopen returns the same assignment', o2.json?.assignment_id === aid);
    c.check(
      'reopen returns identical mission content',
      JSON.stringify({ ...o1.json, xp: 0 }) === JSON.stringify({ ...o2.json, xp: 0 })
    );
    c.check(
      'attempt XP not awarded again',
      o2.json?.xp?.awarded === false && (await studentRow(sid)).xp === xp1,
      `(reason=${o2.json?.xp?.reason})`
    );
    const k = await answerKey(aid);
    const s = await submit(sid, aid, k.correct);
    c.check('submit succeeds', s.status === 200 && s.json?.correct === true, `(${s.status})`);
    const t = await one(`SELECT time_to_submit_seconds t FROM assignments WHERE id = ?`, [aid]);
    c.check('time_to_submit_seconds ~ 86400', Number(t.t) >= 86400 && Number(t.t) < 86400 + 120, `(t=${t.t})`);
  }
);

await runCase(
  '4.1',
  6,
  'A student opens the weekly mission first, before any daily slot',
  'The weekly slot is open from the start and serves a mission; afterwards daily slot 1 is still open and serves a different mission.',
  async (c) => {
    const sid = await newCsStudent('weeklyfirst');
    const week = await weekOf(sid);
    const weekly = week.slots.find((s) => s.is_weekly);
    c.check('weekly slot open at start', weekly?.status === 'open', `(status=${weekly?.status})`);
    const o = await openSlot(sid, weekly.slot_id);
    c.check('weekly serves a mission', !!o.json?.assignment_id, `(${o.status} ${o.text.slice(0, 100)})`);
    const w2 = await weekOf(sid);
    c.check('daily slot 1 still open', slotByIndex(w2, 1).status === 'open');
    const d1 = await openSlot(sid, slotByIndex(w2, 1).slot_id);
    c.check(
      'daily slot 1 serves a different mission',
      d1.json?.assignment_id && d1.json.assignment_id !== o.json.assignment_id
    );
  }
);

await runCase(
  '4.1',
  7,
  'A student tries to open a locked slot directly by URL',
  'API: POST /api/slot/<locked>/open returns 403 and the slot stays unfilled (no assignment created). Web: /mission/<locked> renders a non-5xx page that shows no mission and no stack trace.',
  async (c) => {
    const sid = await newCsStudent('lockedurl');
    const week = await weekOf(sid);
    const locked = slotByIndex(week, 3);
    c.check('slot 3 is locked', locked.status === 'locked');
    const r = await openSlot(sid, locked.slot_id);
    c.check('API refuses with 403', r.status === 403, `(${r.status} ${r.text.slice(0, 100)})`);
    const row = await one(`SELECT assignment_id FROM week_slots WHERE id = ?`, [locked.slot_id]);
    c.check('slot not filled by the attempt', row.assignment_id == null);
    // The web half must see the locked-slot screen itself, not merely "no radio
    // buttons" — the login page also has no radio buttons.
    const webCheck = async (who, studentId, slotId) => {
      const { ctx, page } = await studentPage(studentId);
      try {
        const resp = await page.goto(`/mission/${slotId}`);
        await page.waitForLoadState('networkidle').catch(() => {});
        const body = await page.locator('body').innerText();
        const where = `(url=${page.url().replace(WEB, '')} text="${body.replace(/\s+/g, ' ').slice(0, 110)}")`;
        c.check(`${who}: web page is not a 5xx`, resp.status() < 500, `(status=${resp.status()})`);
        c.check(
          `${who}: web shows the locked-slot message`,
          /\bLocked\b/.test(body) && !page.url().endsWith('/login'),
          where
        );
        c.check(`${who}: web shows no answer options`, (await page.locator('input[type=radio]').count()) === 0);
        c.check(`${who}: web shows no stack trace`, !LEAK_RE.test(body), where);
      } finally {
        await ctx.close();
      }
    };
    await webCheck(`new student id ${sid}`, sid, locked.slot_id);
    const seeded = (await api('GET', '/api/week/1', { as: 1 })).json.slots.find((s) => s.status === 'locked');
    await webCheck('seeded student id 1', 1, seeded.slot_id);
  }
);

await runCase(
  '4.1',
  8,
  'A student completes the week and tries to open another slot',
  'For the student from case 1: no slot is open; re-opening each completed slot returns its existing assignment without creating a new one or awarding XP; re-submitting a graded assignment returns the stored result for that assignment, marked already_submitted, and awards no XP and no second grade.',
  async (c) => {
    // Case 1 leaves one behind; if it has not run (or ran after this one),
    // build the same end state here rather than skipping the case.
    const sid = await completedWeekStudent();
    const week = await weekOf(sid);
    c.check(
      'no slot left open',
      week.slots.every((s) => s.status !== 'open'),
      `(statuses=${week.slots.map((s) => s.status).join(',')})`
    );
    const before = await one(`SELECT COUNT(*) n FROM assignments WHERE student_id = ?`, [sid]);
    const xp = (await studentRow(sid)).xp;
    for (const s of week.slots) {
      const r = await openSlot(sid, s.slot_id);
      c.check(
        `re-open slot ${s.slot_index}: same assignment, no error`,
        r.status < 500 && (r.json?.assignment_id == null || Number(r.json.assignment_id) === Number(s.assignment_id)),
        `(${r.status})`
      );
    }
    const after = await one(`SELECT COUNT(*) n FROM assignments WHERE student_id = ?`, [sid]);
    c.check('no new assignment created', Number(after.n) === Number(before.n), `(${before.n} -> ${after.n})`);
    // A re-submit is not an error: the assignment IS graded, so the student is
    // shown the result they already have (marked already_submitted), never a
    // second grade. It used to answer 400 "not open", which left a student
    // whose first response was lost with no way back to their own result.
    const aid = week.slots[0].assignment_id;
    const gradesBefore = Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n);
    // The answer this assignment was actually graded on, read from the row —
    // not an assumption about which letter that happens to be.
    const storedRow = await one(`SELECT response FROM assignments WHERE id = ?`, [aid]);
    const gradedAnswer = (typeof storedRow.response === 'string' ? JSON.parse(storedRow.response) : storedRow.response)
      ?.selected;
    const again = await submit(sid, aid, 'a');
    c.check(
      're-submit returns the stored result',
      again.status === 200,
      `(${again.status} ${again.text.slice(0, 100)})`
    );
    c.check(
      '  ...marked already_submitted',
      again.json?.already_submitted === true,
      `(${again.json?.already_submitted})`
    );
    c.check(
      '  ...with the answer that was actually graded',
      again.json?.selected_option_key === gradedAnswer,
      `(returned=${again.json?.selected_option_key}, graded on=${gradedAnswer}, resent 'a')`
    );
    c.check(
      'no second grade',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n) === gradesBefore,
      `(${gradesBefore} level events before)`
    );
    c.check('no XP awarded by any of this', (await studentRow(sid)).xp === xp);
  }
);

// ========================================= 4.2 Curriculum boundaries ==
// Sections 4.2 and 4.3 run in curriculum mode with the revision mix off. It is
// declared per case (the CURRICULUM state below) rather than set here, so a
// case still gets it when the cases run in another order.
const CURRICULUM = { mode: 'curriculum', curriculum: { revisionMixPercent: 0 } };
const sessionInfo = async (id) =>
  one(
    `SELECT s.id, s.credit_sequence cs, s.sequence seq, p.sequence pseq, c.code FROM sessions s
       JOIN projects p ON p.id = s.project_id JOIN credits c ON c.id = p.credit_id WHERE s.id = ?`,
    [id]
  );
async function choose(sid, extra = {}) {
  const st = await one(`SELECT age, subject, current_level FROM students WHERE id = ?`, [sid]);
  return sel.chooseCurriculumMission(pool, {
    studentId: sid,
    subject: st.subject,
    age: Number(st.age),
    targetLevel: Number(st.current_level),
    ...extra,
  });
}
async function poolLabels(sid) {
  const ids = await cur.getSessionPool(sid, trackId);
  const out = [];
  for (const id of ids) {
    const i = await sessionInfo(id);
    out.push(`${i.code}:${i.cs}`);
  }
  return out;
}
const chosenLabel = async (choice) => {
  if (!choice?.chosen) return 'none';
  const i = await sessionInfo(choice.chosen.session_id);
  return `${i.code}:${i.cs}`;
};

await runCase(
  '4.2',
  9,
  'Student at the very first session (C1/P1/S1)',
  'The session pool is exactly [C1:1], and the chosen mission comes from C1 session 1.',
  async (c) => {
    const sid = await newRoboticsStudent('first', 2, ['C1', 1, 1]);
    const p = await poolLabels(sid);
    c.check('pool is exactly session 1', JSON.stringify(p) === '["C1:1"]', `(${p})`);
    c.check('chosen mission from C1:1', (await chosenLabel(await choose(sid))) === 'C1:1');
  },
  CURRICULUM
);

await runCase(
  '4.2',
  10,
  'Student at the last session of a credit (C1/P3/S8, credit_sequence 25)',
  'Position resolves to credit_sequence 25. The pool is the 25 C1 sessions, 25 down to 1, nothing from C2. Session 25 has no missions (deliberate seed gap), so the chosen mission comes from C1:24.',
  async (c) => {
    const sid = await newRoboticsStudent('lastofcredit', 2, ['C1', 3, 8]);
    const pos = await cur.getPosition(sid, trackId);
    c.check('position credit_sequence 25', Number(pos.creditSequence) === 25, `(got ${pos.creditSequence})`);
    const p = await poolLabels(sid);
    c.check(
      'pool is C1:25..C1:1',
      p.length === 25 && p[0] === 'C1:25' && p.at(-1) === 'C1:1' && p.every((x) => x.startsWith('C1:')),
      `(n=${p.length} first=${p[0]} last=${p.at(-1)})`
    );
    c.check(
      'chosen from C1:24',
      (await chosenLabel(await choose(sid))) === 'C1:24',
      `(${await chosenLabel(await choose(sid))})`
    );
  },
  CURRICULUM
);

await runCase(
  '4.2',
  11,
  'Student at the first session of the second project (C1/P2/S1)',
  'credit_sequence is 10, the pool is exactly C1 sessions 10 down to 1, and the chosen mission is from C1:10.',
  async (c) => {
    const sid = await newRoboticsStudent('p2s1', 2, ['C1', 2, 1]);
    const pos = await cur.getPosition(sid, trackId);
    c.check('credit_sequence 10', Number(pos.creditSequence) === 10, `(got ${pos.creditSequence})`);
    const p = await poolLabels(sid);
    c.check(
      'pool is C1:10..C1:1',
      JSON.stringify(p) === JSON.stringify(Array.from({ length: 10 }, (_, i) => `C1:${10 - i}`)),
      `(${p})`
    );
    c.check('chosen from C1:10', (await chosenLabel(await choose(sid))) === 'C1:10');
  },
  CURRICULUM
);

await runCase(
  '4.2',
  12,
  'Student at the last session of the last credit in the track (C5/P2/S8)',
  'credit_sequence 17. The pool is the 17 C5 sessions. C5 has no missions, so selection relaxes to an EARLIER credit (logged as previous_credits) and serves C2:1, the latest earlier session with content. Never anything ahead (there is nothing ahead).',
  async (c) => {
    const sid = await newRoboticsStudent('lastoftrack', 2, ['C5', 2, 8]);
    const pos = await cur.getPosition(sid, trackId);
    c.check('credit_sequence 17', Number(pos.creditSequence) === 17, `(got ${pos.creditSequence})`);
    const p = await poolLabels(sid);
    c.check('pool is the 17 C5 sessions', p.length === 17 && p.every((x) => x.startsWith('C5:')), `(n=${p.length})`);
    const ch = await choose(sid);
    c.check('served C2:1', (await chosenLabel(ch)) === 'C2:1', `(${await chosenLabel(ch)})`);
    c.check(
      'relaxation logged as previous_credits',
      (ch.relaxations ?? []).includes('curriculum:previous_credits'),
      `(${ch.relaxations})`
    );
  },
  CURRICULUM
);

await runCase(
  '4.2',
  13,
  'A student whose position points at a session with zero live missions (C2/P1/S3)',
  'Not empty: the chosen mission comes from C2:1 (the only earlier C2 session with content), from inside the base pool, with no relaxation step.',
  async (c) => {
    const sid = await newRoboticsStudent('emptysession', 2, ['C2', 1, 3]);
    const live = await one(
      `SELECT COUNT(*) n FROM missions m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id JOIN credits cr ON cr.id = p.credit_id WHERE cr.code='C2' AND s.credit_sequence=3 AND m.status='live'`
    );
    c.check('C2:3 has zero live missions', Number(live.n) === 0, `(live=${live.n})`);
    const ch = await choose(sid);
    c.check('served C2:1', (await chosenLabel(ch)) === 'C2:1', `(${await chosenLabel(ch)})`);
    c.check('no relaxation needed', (ch.relaxations ?? []).length === 0, `(${ch.relaxations})`);
  },
  CURRICULUM
);

await runCase(
  '4.2',
  14,
  'A student with no position at all, in curriculum mode (over HTTP)',
  'Opening a slot returns an empty result, no assignment is created, and the server logs alert=missing_curriculum_position for this student. It must NOT fall back to legacy selection.',
  async (c) => {
    await hook('selection-mode', { mode: 'curriculum' });
    try {
      const sid = await newRoboticsStudent('noposition', 2, null);
      await publishWeek(sid, await currentMonday());
      const week = (await api('GET', `/api/week/${sid}`, { as: sid })).json;
      const r = await openSlot(sid, slotByIndex(week, 1).slot_id);
      c.check(
        'slot open returns empty',
        r.status === 200 && r.json?.empty === true,
        `(${r.status} ${r.text.slice(0, 120)})`
      );
      const a = await one(`SELECT COUNT(*) n FROM assignments WHERE student_id = ?`, [sid]);
      c.check('no assignment created (no legacy fallback)', Number(a.n) === 0, `(assignments=${a.n})`);
      const logs = (await api('GET', '/api/test/logs')).json;
      const arr = Array.isArray(logs) ? logs : (logs?.items ?? logs?.logs ?? []);
      const alert = arr.find((l) => l.alert === 'missing_curriculum_position' && Number(l.studentId) === sid);
      c.check('alert logged for this student', !!alert, `(matching=${!!alert}, logs=${arr.length})`);
    } finally {
      await hook('selection-mode', { mode: 'legacy' });
    }
  },
  CURRICULUM
);

await runCase(
  '4.2',
  15,
  'Percentages at the edges (credit C1, 25 sessions)',
  '0% -> 1 (floor 0, clamped up to the first session), 1% -> 1, 99% -> 24 (24.75 rounds DOWN), 100% -> 25, 36% -> 9 exactly (last session of P1), 40% -> 10 exactly (first session of P2). Mapped positions: 36% = C1/P1/S9, 40% = C1/P2/S1.',
  async (c) => {
    for (const [p, want] of [
      [0, 1],
      [1, 1],
      [99, 24],
      [100, 25],
      [36, 9],
      [40, 10],
    ]) {
      const got = cur.sessionIndexFromPercent(p, 25); // -> { raw, index }
      c.check(`${p}% of 25 -> ${want}`, got.index === want, `(raw=${got.raw} index=${got.index})`);
    }
    const c1 = (await one(`SELECT id FROM credits WHERE track_id = ? AND code = 'C1'`, [trackId])).id;
    for (const [p, want] of [
      [36, 'C1/P1/S9'],
      [40, 'C1/P2/S1'],
    ]) {
      const d = await cur.derivePositionFromPercent(p, 'credit', trackId, { creditId: c1 });
      const i = await sessionInfo(d.sessionId);
      c.check(
        `${p}% maps to ${want}`,
        `${i.code}/P${i.pseq}/S${i.seq}` === want,
        `(got ${i.code}/P${i.pseq}/S${i.seq})`
      );
    }
  },
  CURRICULUM
);

await runCase(
  '4.2',
  16,
  'A percentage above 100 and a negative percentage',
  'Both are rejected (throw) rather than clamped: 100.01, 150, -0.01 and -1.',
  async (c) => {
    for (const p of [100.01, 150, -0.01, -1]) {
      let threw = false;
      let got;
      try {
        got = cur.sessionIndexFromPercent(p, 25);
      } catch {
        threw = true;
      }
      c.check(`${p}% rejected`, threw, threw ? '' : `(returned ${got})`);
    }
  },
  CURRICULUM
);

await runCase(
  '4.2',
  17,
  'Two students at the same position can receive the same mission',
  'Repeat avoidance is per student: when A and B at C1/P1/S1 have each seen the same 4 of the 5 S1 missions, both are served the remaining one — and B still gets it after A has been assigned it.',
  async (c) => {
    const a = await newRoboticsStudent('sameA', 2, ['C1', 1, 1]);
    const b = await newRoboticsStudent('sameB', 2, ['C1', 1, 1]);
    const s1 = await cur.findSession(trackId, 'C1', 1, 1);
    const ms = await q(
      `SELECT id, version, difficulty FROM missions WHERE session_id = ? AND status = 'live' ORDER BY difficulty`,
      [s1]
    );
    const keep = ms.find((m) => Number(m.difficulty) === 2) ?? ms[0];
    for (const sid of [a, b])
      for (const m of ms.filter((x) => x.id !== keep.id))
        await q(
          `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status) VALUES (?, ?, ?, 2, 'graded')`,
          [sid, m.id, m.version]
        );
    const ca = await choose(a);
    c.check(
      'A is offered the remaining mission',
      ca.chosen?.mission_id === keep.id,
      `(got ${ca.chosen?.mission_id}, want ${keep.id})`
    );
    await q(
      `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status) VALUES (?, ?, ?, 2, 'open')`,
      [a, keep.id, keep.version]
    );
    const cb = await choose(b);
    c.check(
      'B is offered the same mission after A holds it',
      cb.chosen?.mission_id === keep.id,
      `(got ${cb.chosen?.mission_id})`
    );
  },
  CURRICULUM
);

// ====================================== 4.3 Revision and exhaustion ==
await runCase(
  '4.3',
  18,
  'Exhaust a session pool completely and check the relaxation order',
  'With every mission consumed and a slot type nothing satisfies, fillSlot walks, in exactly this order: widen_credit, previous_credits, widen_time_band, repeat_oldest, exhausted — and selection_log records the same order.',
  async (c) => {
    cfg.setPoolLookbackSessions(1);
    try {
      const sid = await newRoboticsStudent('exhaust', 2, ['C1', 1, 4]);
      await q(
        `INSERT INTO assignments (student_id, mission_id, mission_version, level_at_assign, status, assigned_at)
       SELECT ?, m.id, m.version, 2, 'graded', DATE_SUB(UTC_TIMESTAMP(), INTERVAL m.id MINUTE) FROM missions m
         JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id JOIN credits cr ON cr.id = p.credit_id
        WHERE cr.track_id = ?`,
        [sid, trackId]
      );
      const wk = await publishWeek(sid, '2026-12-07');
      const probe = await q(
        `INSERT INTO week_slots (student_week_id, slot_index, day_label, mission_type, time_band, status) VALUES (?, 9, 'Probe', 'project', 'short', 'open')`,
        [wk.studentWeekId]
      );
      const fill = await fillSlot(Number(probe.insertId));
      const want = [
        'curriculum:widen_credit',
        'curriculum:previous_credits',
        'curriculum:widen_time_band',
        'curriculum:repeat_oldest',
        'curriculum:exhausted',
      ];
      c.check('fillSlot order', JSON.stringify(fill.relaxations) === JSON.stringify(want), `(${fill.relaxations})`);
      const log = await one(
        `SELECT filters_applied f FROM selection_log WHERE student_id = ? ORDER BY id DESC LIMIT 1`,
        [sid]
      );
      c.check(
        'selection_log order',
        JSON.stringify(parse(log.f).relaxations) === JSON.stringify(want),
        `(${parse(log.f).relaxations})`
      );
    } finally {
      cfg.setPoolLookbackSessions(0);
    }
  },
  CURRICULUM
);

let revisionFixture = null;
async function revisionRun() {
  if (revisionFixture) return revisionFixture;
  await hook('selection-mode', { mode: 'curriculum' });
  await hook('curriculum-config', { revisionMixPercent: 0 });
  await hook('feedback-gating', { enabled: false });
  const sid = await newRoboticsStudent('revision', 2, ['C1', 1, 1]);
  await publishWeek(sid, await currentMonday());
  const served = [];
  try {
    for (let i = 1; i <= 7; i++) {
      // A real student opens slots at least seconds apart. assigned_at has
      // one-second resolution, and repeat_oldest ranks by it, so opening all
      // seven within one second makes every candidate tie. That edge is
      // reported separately; this fixture models real use.
      if (i > 1) await sleep(1100);
      const week = (await api('GET', `/api/week/${sid}`, { as: sid })).json;
      const s = slotByIndex(week, i);
      const o = await openSlot(sid, s.slot_id);
      if (!o.json?.assignment_id) {
        served.push({ i, empty: true, o });
        continue;
      }
      const aid = o.json.assignment_id;
      const k = await answerKey(aid);
      const row = await one(`SELECT is_revision r, revision_seq n FROM assignments WHERE id = ?`, [aid]);
      const sub = await submit(sid, aid, k.correct);
      served.push({ i, aid, missionId: k.missionId, revision: !!Number(row.r), seq: Number(row.n), sub });
    }
  } finally {
    await hook('selection-mode', { mode: 'legacy' });
    await hook('curriculum-config', { revisionMixPercent: 20 });
    await hook('feedback-gating', { enabled: true });
  }
  revisionFixture = { sid, served };
  return revisionFixture;
}

await runCase(
  '4.3',
  19,
  'A revision repeat awards attempt and submit XP but never correct XP',
  'At C1/P1/S1 (5 missions) the 6th daily slot is a revision repeat. Graded correct, it earns exactly one attempt and one submit xp_event, and zero correct xp_events; the submit response reports xp.correct as null/not awarded.',
  async (c) => {
    const { served } = await revisionRun();
    const rev = served.find((s) => s.revision);
    if (
      !c.check(
        'a revision repeat was served',
        !!rev,
        `(served=${served.map((s) => (s.empty ? 'empty' : s.revision ? 'REV' : 'new')).join(',')})`
      )
    )
      return;
    c.check(
      'first 5 were not revisions',
      served.slice(0, 5).every((s) => !s.revision)
    );
    const ev = await q(`SELECT event_type, COUNT(*) n FROM xp_events WHERE assignment_id = ? GROUP BY event_type`, [
      rev.aid,
    ]);
    const n = (t) => Number(ev.find((e) => e.event_type === t)?.n ?? 0);
    c.check('revision graded correct', rev.sub.json?.correct === true);
    c.check('attempt XP once', n('attempt') === 1, `(${n('attempt')})`);
    c.check('submit XP once', n('submit') === 1, `(${n('submit')})`);
    c.check('correct XP never', n('correct') === 0, `(${n('correct')})`);
    c.check(
      'response reports no correct award',
      !rev.sub.json?.xp?.correct?.awarded,
      `(${JSON.stringify(rev.sub.json?.xp?.correct)})`
    );
  },
  CURRICULUM
);

await runCase(
  '4.3',
  20,
  'Try to earn correct XP twice on the same mission via revision',
  'Across every assignment of the repeated mission, the student has exactly ONE correct xp_event — earned on the original pass — even though both passes were graded correct.',
  async (c) => {
    const { sid, served } = await revisionRun();
    const rev = served.find((s) => s.revision);
    if (!rev) return c.notTested('no revision repeat was served (see case 19)');
    const r = await one(
      `SELECT COUNT(*) n FROM xp_events x JOIN assignments a ON a.id = x.assignment_id WHERE a.student_id = ? AND a.mission_id = ? AND x.event_type = 'correct'`,
      [sid, rev.missionId]
    );
    const passes = await one(
      `SELECT COUNT(*) n FROM assignments WHERE student_id = ? AND mission_id = ? AND status = 'graded'`,
      [sid, rev.missionId]
    );
    c.check('mission graded on two passes', Number(passes.n) === 2, `(passes=${passes.n})`);
    c.check('exactly one correct xp_event across both', Number(r.n) === 1, `(correct events=${r.n})`);
  },
  CURRICULUM
);

await runCase(
  '4.3',
  21,
  'REVISION_MIX_PERCENT at 0, 20 and 100 over 200 draws each',
  'Student at C1/P1/S4 with unseen missions in S4. 0% -> 0/200 draws from an earlier session. 100% -> 200/200. 20% -> between 24 and 56 of 200 (12%-28%, roughly +/-2.8 standard deviations of a binomial(200, 0.2)).',
  async (c) => {
    const sid = await newRoboticsStudent('mix', 2, ['C1', 1, 4]);
    const s4 = await cur.findSession(trackId, 'C1', 1, 4);
    for (const [p, lo, hi] of [
      [0, 0, 0],
      [20, 24, 56],
      [100, 200, 200],
    ]) {
      cfg.setRevisionMixPercent(p);
      let earlier = 0;
      for (let i = 0; i < 200; i++) {
        const ch = await choose(sid);
        if (ch.chosen && ch.chosen.session_id !== s4) earlier++;
      }
      c.check(`${p}%: ${earlier}/200 earlier`, earlier >= lo && earlier <= hi, `(allowed ${lo}-${hi})`);
    }
    cfg.setRevisionMixPercent(0);
  },
  CURRICULUM
);
// ========================================= 4.4 Concurrency ==
await runCase(
  '4.4',
  22,
  'Two simultaneous submissions of the same answer',
  'Exactly one request grades (200); the other is refused with a 4xx, never a 5xx. Exactly one submit xp_event, one correct xp_event, one level_event and one "submitted" attempt log.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const sid = await newCsStudent('concur-same');
    const o = await openSlot(sid, slotByIndex(await weekOf(sid), 1).slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    const rs = await Promise.all([submit(sid, aid, k.correct), submit(sid, aid, k.correct)]);
    const st = rs.map((r) => r.status).sort();
    c.check('one 200 and one 4xx', st[0] === 200 && st[1] >= 400 && st[1] < 500, `(${st})`);
    const x = await q(`SELECT event_type, COUNT(*) n FROM xp_events WHERE assignment_id = ? GROUP BY event_type`, [
      aid,
    ]);
    const n = (t) => Number(x.find((e) => e.event_type === t)?.n ?? 0);
    c.check('submit XP once', n('submit') === 1, `(${n('submit')})`);
    c.check('correct XP once', n('correct') === 1, `(${n('correct')})`);
    c.check(
      'one level_event',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n) === 1
    );
    c.check(
      'one submitted log',
      Number(
        (await one(`SELECT COUNT(*) n FROM attempt_logs WHERE assignment_id = ? AND event = 'submitted'`, [aid])).n
      ) === 1
    );
  }
);

await runCase(
  '4.4',
  23,
  'Two simultaneous submissions of DIFFERENT answers to the same assignment',
  "Exactly one grades; the stored response is the winning request's answer; XP and the level change match the winner only (one level_event).",
  async (c) => {
    const sid = await newCsStudent('concur-diff');
    const o = await openSlot(sid, slotByIndex(await weekOf(sid), 1).slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    const w = wrongOf(k.correct);
    const [r1, r2] = await Promise.all([submit(sid, aid, k.correct), submit(sid, aid, w)]);
    const winners = [r1, r2].filter((r) => r.status === 200);
    c.check('exactly one 200', winners.length === 1, `(${r1.status},${r2.status})`);
    const row = await one(`SELECT response, status FROM assignments WHERE id = ?`, [aid]);
    const stored = String(parse(row.response)?.selected ?? row.response);
    const winnerAnswer = winners[0] === r1 ? k.correct : w;
    c.check(
      "stored answer = winner's answer",
      stored.includes(winnerAnswer),
      `(stored=${stored}, winner=${winnerAnswer})`
    );
    const corr = Number(
      (await one(`SELECT COUNT(*) n FROM xp_events WHERE assignment_id = ? AND event_type='correct'`, [aid])).n
    );
    c.check('correct XP matches the winner', corr === (winnerAnswer === k.correct ? 1 : 0), `(correct events=${corr})`);
    c.check(
      'one level_event',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n) === 1
    );
  }
);

await runCase(
  '4.4',
  24,
  'Double-tap on the feedback submit',
  'With gating on: both requests return non-5xx; responses are stored once (4 rows, not 8); feedback XP awarded once; exactly ONE next slot unlocks — slot 2 open, slot 3 still locked.',
  async (c) => {
    await hook('feedback-gating', { enabled: true });
    const sid = await newCsStudent('fb-double');
    const week = await weekOf(sid);
    const o = await openSlot(sid, slotByIndex(week, 1).slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    await submit(sid, aid, k.correct);
    const rs = await Promise.all([feedback(sid, aid), feedback(sid, aid)]);
    c.check(
      'neither request 5xx',
      rs.every((r) => r.status < 500),
      `(${rs.map((r) => r.status)})`
    );
    c.check(
      'responses stored once',
      Number((await one(`SELECT COUNT(*) n FROM feedback_responses WHERE assignment_id = ?`, [aid])).n) === 4
    );
    c.check(
      'feedback XP once',
      Number(
        (await one(`SELECT COUNT(*) n FROM xp_events WHERE assignment_id = ? AND event_type='feedback'`, [aid])).n
      ) === 1
    );
    const w2 = await weekOf(sid);
    c.check('slot 2 open', slotByIndex(w2, 2).status === 'open', `(${slotByIndex(w2, 2).status})`);
    c.check('slot 3 still locked', slotByIndex(w2, 3).status === 'locked', `(${slotByIndex(w2, 3).status})`);
  }
);

await runCase(
  '4.4',
  25,
  'Same Idempotency-Key, different answer body',
  'The first request grades. The second (same key, different answer) must NOT be graded, and must be REJECTED with a 4xx (per the IETF Idempotency-Key draft, a reused key with a different payload is an error). Silently replaying the first result would tell the student their new answer was graded when it was not — recorded as a failure.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const sid = await newCsStudent('idem-diff');
    const o = await openSlot(sid, slotByIndex(await weekOf(sid), 1).slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    const key = randomUUID();
    const r1 = await submit(sid, aid, k.correct, key);
    const r2 = await submit(sid, aid, wrongOf(k.correct), key);
    c.check('first request graded', r1.status === 200 && r1.json?.correct === true);
    c.check(
      'graded exactly once',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n) === 1
    );
    c.note(`second request -> ${r2.status} ${r2.text.slice(0, 160)}`);
    c.check(
      'second request rejected with 4xx',
      r2.status >= 400 && r2.status < 500,
      `(got ${r2.status}${r2.json?.idempotent_replay ? ', replayed the FIRST result as if it were this answer' : ''})`
    );
  }
);

await runCase(
  '4.4',
  26,
  'Two browser tabs open on the same slot, submitting from both',
  'Both tabs get the same assignment. The first submit grades; the second (its own Idempotency-Key, a different answer) gets the stored result from the first tab, marked already_submitted and carrying the graded answer — never a 5xx and never a second grade.',
  async (c) => {
    const sid = await newCsStudent('twotabs');
    const s = slotByIndex(await weekOf(sid), 1);
    const a = await openSlot(sid, s.slot_id);
    const b = await openSlot(sid, s.slot_id);
    c.check('both tabs see the same assignment', a.json.assignment_id === b.json.assignment_id);
    const k = await answerKey(a.json.assignment_id);
    const r1 = await submit(sid, a.json.assignment_id, k.correct, randomUUID());
    const r2 = await submit(sid, b.json.assignment_id, wrongOf(k.correct), randomUUID());
    c.check('tab A graded', r1.status === 200);
    // Tab B is the same student looking at the same, now-graded assignment: it
    // shows tab A's result rather than an error (see case 8).
    c.check('tab B gets the stored result, not a 5xx', r2.status === 200, `(${r2.status} ${r2.text.slice(0, 120)})`);
    c.check(
      'tab B is told it was already submitted',
      r2.json?.already_submitted === true,
      `(${r2.json?.already_submitted})`
    );
    c.check(
      "tab B shows tab A's answer, not its own",
      r2.json?.selected_option_key === k.correct,
      `(shown=${r2.json?.selected_option_key}, tab B sent=${wrongOf(k.correct)})`
    );
    c.check('tab B message is not internal', !LEAK_RE.test(r2.text), `(${r2.text.slice(0, 120)})`);
    c.check(
      'one grade',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [a.json.assignment_id])).n) === 1
    );
  }
);

await runCase(
  '4.4',
  27,
  'The same student opening two different slots simultaneously',
  'Over 15 trials (fresh student each), opening daily slot 1 and the weekly slot at the same moment always returns 200 for both, with two DIFFERENT assignments on two DIFFERENT missions — no 5xx, no duplicate-key error.',
  async (c) => {
    let bad = 0;
    const detail = [];
    for (let t = 0; t < 15; t++) {
      const sid = await newCsStudent(`twoslots${t}`);
      const w = await weekOf(sid);
      const [r1, r2] = await Promise.all([
        openSlot(sid, slotByIndex(w, 1).slot_id),
        openSlot(sid, w.slots.find((s) => s.is_weekly).slot_id),
      ]);
      const a1 = r1.json?.assignment_id;
      const a2 = r2.json?.assignment_id;
      // The mission payload carries no mission id, so compare the assignments' missions in the DB.
      const m = a1 && a2 ? await q(`SELECT id, mission_id FROM assignments WHERE id IN (?, ?)`, [a1, a2]) : [];
      const ok =
        r1.status === 200 &&
        r2.status === 200 &&
        a1 &&
        a2 &&
        a1 !== a2 &&
        m.length === 2 &&
        m[0].mission_id !== m[1].mission_id;
      if (!ok) {
        bad++;
        detail.push(
          `t${t}:${r1.status}/${r2.status} a=${a1}/${a2} missions=${m.map((x) => x.mission_id).join('/')} ${(r1.status >= 500 ? r1.text : r2.text).slice(0, 80)}`
        );
      }
    }
    c.check('all 15 trials clean', bad === 0, `(bad=${bad} ${detail.join(' ; ')})`);
  }
);
// =================================== 4.5 Authentication and authorisation ==
await runCase(
  '4.5',
  28,
  "Student A requests each of student B's endpoints",
  'Every one returns 403 — none returns 200, and none returns 404 (the spec asks for 403 so a probe cannot distinguish "not yours" from "does not exist").',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const A = await newCsStudent('ownerA');
    const B = await newCsStudent('ownerB');
    const wb = await weekOf(B);
    const done = await completeSlot(B, slotByIndex(wb, 1).slot_id, true, { fb: false });
    const bAid = done.aid;
    const bSlot = slotByIndex(wb, 2).slot_id;
    await hook('feedback-gating', { enabled: true });
    const probes = [
      ['GET', `/api/week/${B}`],
      ['GET', `/api/current/${B}`],
      ['GET', `/api/xp/${B}`],
      ['GET', `/api/segment/${B}`],
      ['GET', `/api/history/${B}`],
      ['GET', `/api/progress/${B}`],
      ['GET', `/api/submissions/${B}`],
      ['GET', `/api/attempts/${bAid}`],
      ['GET', `/api/assignment/${bAid}/review`],
      ['POST', `/api/slot/${bSlot}/open`],
      ['POST', '/api/submit', { assignmentId: bAid, selected: 'a' }],
      ['POST', `/api/feedback/${bAid}`, { answers: VALID_FEEDBACK }],
    ];
    for (const [m, p, body] of probes) {
      const r = await api(m, p, { as: A, body });
      c.check(
        `${m} ${p} -> 403`,
        r.status === 403,
        `(got ${r.status}${r.status === 200 ? ' BODY=' + r.text.slice(0, 80) : ''})`
      );
    }
  }
);

await runCase(
  '4.5',
  29,
  'A student requests /quality, the roster and the assistance queue',
  'All refused: /quality, /api/students, /api/assistance, /api/mission-quality and /api/missions each return 401/403 to a student; an anonymous /quality is redirected to the login page, without the page.',
  async (c) => {
    for (const p of ['/quality', '/api/students', '/api/assistance', '/api/mission-quality', '/api/missions']) {
      const r = await api('GET', p, { as: 1 });
      c.check(
        `student GET ${p} refused`,
        r.status === 401 || r.status === 403,
        `(got ${r.status}, ${r.headers.get('content-type')})`
      );
    }
    // Refused, as a page should refuse an anonymous browser: a redirect to the
    // login page (Phase 5 spec) — and none of the page's content.
    const anon = await fetch(BASE + '/quality', { redirect: 'manual' });
    const body = await anon.text();
    c.check(
      'anonymous GET /quality refused (redirect to /login, no page)',
      anon.status === 302 && /\/login$/.test(anon.headers.get('location') ?? '') && !body.includes('Quality'),
      `(got ${anon.status} location=${anon.headers.get('location')})`
    );
  }
);

await runCase(
  '4.5',
  30,
  'An SME attempts to submit a mission',
  'POST /api/submit with an SME session returns 403 and grades nothing.',
  async (c) => {
    const s = await staffLogin('sme');
    const aid = (await one(`SELECT id FROM assignments WHERE status = 'open' LIMIT 1`))?.id ?? 1;
    const r = await api('POST', '/api/submit', {
      body: { assignmentId: aid, selected: 'a' },
      headers: { Cookie: s.cookie },
    });
    c.check('SME submit -> 403', r.status === 403, `(got ${r.status} ${r.text.slice(0, 100)})`);
  }
);

await runCase(
  '4.5',
  31,
  'An instructor resolves an assistance event without a note',
  'Resolve with no body, {note:""} and {note:"   "} each return 400, and the event is still unresolved afterwards.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const sid = await newCsStudent('stall-for-note');
    for (let i = 1; i <= 3; i++) {
      const w = await weekOf(sid);
      await completeSlot(sid, slotByIndex(w, i).slot_id, false, { fb: false });
    }
    await hook('feedback-gating', { enabled: true });
    const ev = await one(`SELECT id FROM assistance_events WHERE student_id = ? ORDER BY id DESC LIMIT 1`, [sid]);
    if (!ev) return c.check('an assistance event exists to resolve', false);
    const s = await staffLogin('instructor');
    await api('POST', `/api/assistance/${ev.id}/acknowledge`, { headers: { Cookie: s.cookie } });
    for (const [label, body] of [
      ['no body', undefined],
      ['empty note', { note: '' }],
      ['whitespace note', { note: '   ' }],
    ]) {
      const r = await api('POST', `/api/assistance/${ev.id}/resolve`, { body, headers: { Cookie: s.cookie } });
      c.check(`${label} -> 400`, r.status === 400, `(got ${r.status} ${r.text.slice(0, 100)})`);
    }
    const st = await one(`SELECT status FROM assistance_events WHERE id = ?`, [ev.id]);
    c.check('event still unresolved', st.status !== 'resolved', `(status=${st.status})`);
  }
);

await runCase(
  '4.5',
  32,
  'Requests with no session, an expired session and a tampered session cookie',
  'All three are refused with 401. An "expired" session is a cookie presented more than 12h after issue: the server must refuse it, which requires an issue time the server can check.',
  async (c) => {
    const none = await api('GET', '/api/me');
    c.check('no session -> 401', none.status === 401, `(got ${none.status})`);
    const s = await staffLogin('sme');
    const parts = Object.fromEntries(
      s.cookie.split('; ').map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')])
    );
    const payload = Buffer.from(parts.mh_session, 'base64').toString('utf8');
    c.note(
      `issued session payload = ${payload}; Set-Cookie = ${(s.res.headers.getSetCookie?.() ?? [])
        .find((x) => x.startsWith('mh_session='))
        ?.split(';')
        .slice(1)
        .join(';')}`
    );
    const forged = Buffer.from(
      payload.replace(/"uid":\d+/, `"uid":${(await one(`SELECT id FROM students WHERE role='admin' LIMIT 1`)).id}`)
    ).toString('base64');
    const tamperedPayload = await api('GET', '/api/me', {
      headers: { Cookie: `mh_session=${forged}; mh_session.sig=${parts['mh_session.sig']}` },
    });
    c.check(
      'tampered payload (uid swapped to admin) -> 401',
      tamperedPayload.status === 401,
      `(got ${tamperedPayload.status} ${tamperedPayload.text.slice(0, 80)})`
    );
    const badSig = await api('GET', '/api/me', {
      headers: { Cookie: `mh_session=${parts.mh_session}; mh_session.sig=${'x' + parts['mh_session.sig'].slice(1)}` },
    });
    c.check('tampered signature -> 401', badSig.status === 401, `(got ${badSig.status})`);
    const hasTime = /"(iat|exp|issued|expires|ts)"/i.test(payload);
    c.check('the session payload carries an issue time the server can check', hasTime, `(payload=${payload})`);
    // The expired case itself: a VALIDLY SIGNED session issued 13h ago, which is
    // exactly what a copied cookie looks like when replayed after the 12h limit.
    const { default: Keygrip } = await import('keygrip');
    const { sessionSecret } = await import('./src/session.js');
    const oldValue = Buffer.from(
      JSON.stringify({ ...JSON.parse(payload), iat: Math.floor(Date.now() / 1000) - 13 * 3600 })
    ).toString('base64');
    const oldCookie = `mh_session=${oldValue}; mh_session.sig=${new Keygrip([sessionSecret()]).sign(`mh_session=${oldValue}`)}`;
    const expired = await api('GET', '/api/me', { headers: { Cookie: oldCookie } });
    c.check('expired (13h old, validly signed) session -> 401', expired.status === 401, `(got ${expired.status})`);
  }
);

await runCase(
  '4.5',
  33,
  'Login rate limit: six failed attempts, then a correct password',
  'Attempts 1-5 return 401; attempt 6 returns 429; the correct password immediately afterwards is ALSO 429 (the lock holds).',
  async (c) => {
    await hook('reset-rate-limit');
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await staffLogin('instructor', 'wrong-pass')).status);
    c.check(
      '1-5 -> 401',
      codes.slice(0, 5).every((x) => x === 401),
      `(${codes})`
    );
    c.check('6 -> 429', codes[5] === 429, `(${codes})`);
    const good = await staffLogin('instructor', 'changeme');
    c.check('correct password while locked -> 429', good.status === 429, `(got ${good.status})`);
    await hook('reset-rate-limit');
  }
);

await runCase(
  '4.5',
  34,
  'Rate-limit response identical for an existing and a non-existent username',
  'Both the pre-lock 401 and the locked 429 responses are identical (status, body minus request id, Retry-After) for "instructor" and "nosuch-user-zz9".',
  async (c) => {
    await hook('reset-rate-limit');
    const run = async (u) => {
      const rs = [];
      for (let i = 0; i < 6; i++) rs.push((await staffLogin(u, 'wrong-pass')).res);
      return rs;
    };
    // requestId is per-request by design and lives inside `error`; everything else must match.
    const strip = (r) => {
      const b = r.json ? JSON.parse(JSON.stringify(r.json)) : r.text;
      if (b?.error) delete b.error.requestId;
      return JSON.stringify({ s: r.status, b, ra: r.headers.get('retry-after') });
    };
    const a = await run('instructor');
    const b = await run('nosuch-user-zz9');
    c.check('401 responses identical', strip(a[0]) === strip(b[0]), `(${strip(a[0])} vs ${strip(b[0])})`);
    c.check('429 responses identical', strip(a[5]) === strip(b[5]), `(${strip(a[5])} vs ${strip(b[5])})`);
    await hook('reset-rate-limit');
  }
);

await runCase(
  '4.5',
  35,
  'A CSRF mismatch with CSRF_ENFORCED=true',
  'On a real API instance started with CSRF_ENFORCED=true: a staff mutation with a mismatched X-CSRF-Token is refused 403; the same request with the matching token is not refused for CSRF.',
  async (c) => {
    const inst = await spawnApi(3012, { CSRF_ENFORCED: 'true' });
    try {
      if (!inst.ok) return c.notTested(`CSRF instance did not start: ${inst.log().slice(-300)}`);
      // A bare login POST with no CSRF cookie/header: recorded, since the double-submit
      // scheme treats login as a mutation too.
      const bare = await staffLogin('instructor', 'changeme', inst.base);
      c.note(`bare login POST (no token) under enforcement -> ${bare.status} ${bare.res.text.slice(0, 100)}`);
      // Real flow: a GET issues the readable mh_csrf cookie, the client echoes it.
      const pre = await api('GET', '/login', { base: inst.base });
      const csrfCookie = cookieOf(pre) || cookieOf(bare.res);
      const token = /mh_csrf=([^;]+)/.exec(csrfCookie)?.[1];
      if (!c.check('a CSRF cookie is issued before login', !!token, `(cookie=${csrfCookie.slice(0, 80)})`)) return;
      const login = await api('POST', '/api/login', {
        base: inst.base,
        body: { username: 'instructor', password: 'changeme' },
        headers: { Cookie: csrfCookie, 'X-CSRF-Token': token },
      });
      if (
        !c.check(
          'login with the token succeeds',
          login.status === 200,
          `(got ${login.status} ${login.text.slice(0, 100)})`
        )
      )
        return;
      const session = [csrfCookie, cookieOf(login)].filter(Boolean).join('; ');
      const ev = await ensureAssistanceEvent();
      if (!c.check('an assistance event exists to act on', !!ev)) return;
      const bad = await api('POST', `/api/assistance/${ev}/acknowledge`, {
        base: inst.base,
        headers: { Cookie: session, 'X-CSRF-Token': 'not-the-token' },
      });
      c.check(
        'authenticated mutation, mismatched token -> 403',
        bad.status === 403 && /csrf/i.test(bad.text),
        `(got ${bad.status} ${bad.text.slice(0, 100)})`
      );
      const none = await api('POST', `/api/assistance/${ev}/acknowledge`, {
        base: inst.base,
        headers: { Cookie: session },
      });
      c.check(
        'authenticated mutation, missing token -> 403',
        none.status === 403 && /csrf/i.test(none.text),
        `(got ${none.status})`
      );
      const good = await api('POST', `/api/assistance/${ev}/acknowledge`, {
        base: inst.base,
        headers: { Cookie: session, 'X-CSRF-Token': token },
      });
      c.check(
        'authenticated mutation, matching token -> not refused for CSRF',
        !(good.status === 403 && /csrf/i.test(good.text)),
        `(got ${good.status} ${good.text.slice(0, 80)})`
      );
    } finally {
      stopApi(inst);
    }
  }
);

await runCase(
  '4.5',
  36,
  'GET/POST /api/dev/* returns 404 when AUTH_MODE is not dev',
  'On an instance with AUTH_MODE=lti: POST /api/dev/login-as and GET /api/dev/users both 404.',
  async (c) => {
    const inst = await spawnApi(3013, { AUTH_MODE: 'lti' });
    try {
      if (!inst.ok) return c.notTested(`lti instance did not start: ${inst.log().slice(-300)}`);
      const a = await api('POST', '/api/dev/login-as', { base: inst.base, body: { studentId: 1 } });
      const b = await api('GET', '/api/dev/users', { base: inst.base });
      c.check('login-as -> 404', a.status === 404, `(got ${a.status})`);
      c.check('dev users -> 404', b.status === 404, `(got ${b.status})`);
    } finally {
      stopApi(inst);
    }
  }
);

await runCase(
  '4.5',
  37,
  'Test hooks unreachable when ENABLE_TEST_HOOKS is unset',
  'On an instance without ENABLE_TEST_HOOKS, every /api/test/* route returns 403 or 404 — never 200 — and a hook call changes nothing.',
  async (c) => {
    const inst = await spawnApi(3014, {});
    try {
      if (!inst.ok) return c.notTested(`instance did not start: ${inst.log().slice(-300)}`);
      for (const [m, p, body] of [
        ['POST', '/api/test/feedback-gating', { enabled: false }],
        ['POST', '/api/test/selection-mode', { mode: 'curriculum' }],
        ['POST', '/api/test/curriculum-config', { revisionMixPercent: 100 }],
        ['POST', '/api/test/reset-rate-limit'],
        ['POST', '/api/test/clear-feedback-cache'],
        ['GET', '/api/test/logs'],
        ['GET', '/api/test/boom'],
      ]) {
        const r = await api(m, p, { base: inst.base, body });
        c.check(`${m} ${p} unreachable`, r.status === 403 || r.status === 404, `(got ${r.status})`);
      }
    } finally {
      stopApi(inst);
    }
  }
);

// ============================================== 4.6 Input validation ==
await runCase(
  '4.6',
  38,
  'Every mutating endpoint with hostile input',
  'For every endpoint x payload class (malformed JSON, empty body, wrong types, missing fields, extra unknown fields, 1,000,000-char strings, SQL-injection strings): the status is never 5xx, the body never contains a stack trace or raw DB error, invalid input gets a 4xx, SQLi login does not authenticate, and extra fields ({studentId, isCorrect, xp, role}) have no effect.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const sid = await newCsStudent('hostile');
    const w = await weekOf(sid);
    const o = await openSlot(sid, slotByIndex(w, 1).slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    const s = await staffLogin('instructor');
    const ev = (await ensureAssistanceEvent()) ?? 1;
    const BIG = 'x'.repeat(1_000_000);
    const SQLI = "' OR 1=1 --";
    const studentsBefore = Number((await one(`SELECT COUNT(*) n FROM students`)).n);
    const S = { as: sid };
    const I = { headers: { Cookie: s.cookie } };
    const cases = [
      ['submit malformed JSON', 'POST', '/api/submit', { ...S, rawBody: '{"assignmentId": 1,' }],
      ['submit empty body', 'POST', '/api/submit', { ...S }],
      ['submit {}', 'POST', '/api/submit', { ...S, body: {} }],
      ['submit wrong types', 'POST', '/api/submit', { ...S, body: { assignmentId: 'abc', selected: 5 } }],
      ['submit missing selected', 'POST', '/api/submit', { ...S, body: { assignmentId: aid } }],
      ['submit 1M-char selected', 'POST', '/api/submit', { ...S, body: { assignmentId: aid, selected: BIG } }],
      ['submit SQLi selected', 'POST', '/api/submit', { ...S, body: { assignmentId: aid, selected: SQLI } }],
      ['submit SQLi assignmentId', 'POST', '/api/submit', { ...S, body: { assignmentId: `1${SQLI}`, selected: 'a' } }],
      ['feedback malformed JSON', 'POST', `/api/feedback/${aid}`, { ...S, rawBody: '{"answers": [' }],
      ['feedback wrong types', 'POST', `/api/feedback/${aid}`, { ...S, body: { answers: 'lots' } }],
      [
        'feedback 1M-char value',
        'POST',
        `/api/feedback/${aid}`,
        { ...S, body: { answers: [...VALID_FEEDBACK, { question_key: 'comments', value: BIG }] } },
      ],
      [
        'feedback SQLi key',
        'POST',
        `/api/feedback/${aid}`,
        { ...S, body: { answers: [{ question_key: SQLI, value: SQLI }] } },
      ],
      ['login empty body', 'POST', '/api/login', {}],
      ['login wrong types', 'POST', '/api/login', { body: { username: 1, password: [] } }],
      ['login missing password', 'POST', '/api/login', { body: { username: 'sme' } }],
      ['login 1M-char password', 'POST', '/api/login', { body: { username: 'sme', password: BIG } }],
      ['login SQLi username', 'POST', '/api/login', { body: { username: `admin${SQLI}`, password: 'x' } }],
      ['login SQLi password', 'POST', '/api/login', { body: { username: 'admin', password: SQLI } }],
      ['login-as SQLi', 'POST', '/api/dev/login-as', { body: { studentId: `1 OR 1=1` } }],
      ['login-as wrong type', 'POST', '/api/dev/login-as', { body: { studentId: [1] } }],
      ['ack wrong id type', 'POST', '/api/assistance/abc/acknowledge', { ...I }],
      ['resolve wrong type note', 'POST', `/api/assistance/${ev}/resolve`, { ...I, body: { note: 123 } }],
      ['resolve 1M-char note', 'POST', `/api/assistance/${ev}/resolve`, { ...I, body: { note: BIG } }],
      ['resolve SQLi note (valid length)', 'POST', `/api/assistance/${ev}/resolve`, { ...I, body: { note: SQLI } }],
      ['logout junk body', 'POST', '/api/logout', { rawBody: 'not json at all' }],
      ['slot open junk body', 'POST', `/api/slot/${slotByIndex(w, 2).slot_id}/open`, { ...S, rawBody: '{{{{' }],
    ];
    // Payload classes that are INVALID input and must get a 4xx (the stated expectation).
    const MUST_4XX =
      /malformed|empty body|\{\}|wrong type|missing|SQLi assignmentId|SQLi key|login-as|ack wrong id|junk body/;
    await hook('reset-rate-limit');
    for (const [label, m, p, opts] of cases) {
      const r = await api(m, p, opts);
      c.check(`${label}: not 5xx`, r.status < 500 && r.status !== 0, `(got ${r.status})`);
      c.check(`${label}: no internals leaked`, !LEAK_RE.test(r.text), `(${r.text.replace(/\s+/g, ' ').slice(0, 140)})`);
      if (MUST_4XX.test(label))
        c.check(`${label}: invalid input -> 4xx`, r.status >= 400 && r.status < 500, `(got ${r.status})`);
      if (/1M-char/.test(label))
        c.check(`${label}: oversized input -> 4xx`, r.status >= 400 && r.status < 500, `(got ${r.status})`);
      if (/SQLi (username|password)/.test(label))
        c.check(`${label}: not authenticated`, r.status !== 200, `(got ${r.status})`);
      if (label === 'submit SQLi selected')
        c.note(
          `SQLi as an answer -> ${r.status}; stored response = ${JSON.stringify((await one(`SELECT response FROM assignments WHERE id = ?`, [aid]))?.response)}`
        );
    }
    await hook('reset-rate-limit');
    // Extra unknown fields on a real submit, against a FRESH open assignment (the
    // SQLi payload above graded the first one): must not change the owner, the
    // grade or the XP.
    const sid2 = await newCsStudent('hostile-extra');
    const o2 = await openSlot(sid2, slotByIndex(await weekOf(sid2), 1).slot_id);
    const aid2 = o2.json.assignment_id;
    const k2 = await answerKey(aid2);
    const other = await newCsStudent('hostile-other');
    const xpBefore = (await studentRow(sid2)).xp;
    const r = await api('POST', '/api/submit', {
      as: sid2,
      body: {
        assignmentId: aid2,
        selected: wrongOf(k2.correct),
        isCorrect: true,
        correct: true,
        xp: 9999,
        studentId: other,
        score_pct: 100,
      },
    });
    c.check(
      'extra fields: request accepted as a normal (wrong) answer',
      r.status === 200 && r.json?.correct === false,
      `(${r.status} correct=${r.json?.correct})`
    );
    c.check(
      'extra fields: XP is the normal submit amount only',
      (await studentRow(sid2)).xp === xpBefore + xpFor('submit', k2.difficulty),
      `(delta=${(await studentRow(sid2)).xp - xpBefore})`
    );
    c.check('extra fields: other student untouched', (await studentRow(other)).xp === 0);
    const rl = await api('POST', '/api/login', { body: { username: 'sme', password: 'changeme', role: 'admin' } });
    const me = await api('GET', '/api/me', { headers: { Cookie: cookieOf(rl) } });
    c.check('login with role:admin extra field stays sme', me.json?.role === 'sme', `(role=${me.json?.role})`);
    c.check('no rows created by SQLi', Number((await one(`SELECT COUNT(*) n FROM students`)).n) === studentsBefore + 2);
    await hook('feedback-gating', { enabled: true });
  }
);

async function gradedAssignment(tag) {
  await hook('feedback-gating', { enabled: false });
  const sid = await newCsStudent(tag);
  const r = await completeSlot(sid, slotByIndex(await weekOf(sid), 1).slot_id, true, { fb: false });
  await hook('feedback-gating', { enabled: true });
  return { sid, aid: r.aid };
}
const withAnswer = (key, value) => VALID_FEEDBACK.map((a) => (a.question_key === key ? { ...a, value } : a));

await runCase(
  '4.6',
  39,
  'Feedback with a scale value of 0, 6, 3.5 and "three"',
  'Each is rejected with 400, nothing is saved for that assignment, and feedback_status is unchanged.',
  async (c) => {
    const { sid, aid } = await gradedAssignment('scale');
    const statusBefore = (await one(`SELECT feedback_status s FROM assignments WHERE id = ?`, [aid])).s;
    for (const v of ['0', '6', '3.5', 'three']) {
      const r = await feedback(sid, aid, withAnswer('clarity', v));
      c.check(`clarity=${v} -> 400`, r.status === 400, `(got ${r.status} ${r.text.slice(0, 100)})`);
    }
    c.check(
      'nothing saved',
      Number((await one(`SELECT COUNT(*) n FROM feedback_responses WHERE assignment_id = ?`, [aid])).n) === 0
    );
    const statusAfter = (await one(`SELECT feedback_status s FROM assignments WHERE id = ?`, [aid])).s;
    c.check('feedback_status unchanged', statusAfter === statusBefore, `(${statusBefore} -> ${statusAfter})`);
  }
);

await runCase(
  '4.6',
  40,
  'Free-text feedback at exactly 500 and at 501 characters',
  '500 characters is accepted (200) and stored in full; 501 is rejected (400) and nothing is saved.',
  async (c) => {
    const a = await gradedAssignment('ft500');
    const r1 = await feedback(a.sid, a.aid, [...VALID_FEEDBACK, { question_key: 'comments', value: 'a'.repeat(500) }]);
    c.check('500 chars -> 200', r1.status === 200, `(got ${r1.status} ${r1.text.slice(0, 100)})`);
    const stored = await one(
      `SELECT CHAR_LENGTH(answer_value) n FROM feedback_responses WHERE assignment_id = ? AND question_key = 'comments'`,
      [a.aid]
    );
    c.check('stored length 500', Number(stored?.n) === 500, `(stored=${stored?.n})`);
    const b = await gradedAssignment('ft501');
    const r2 = await feedback(b.sid, b.aid, [...VALID_FEEDBACK, { question_key: 'comments', value: 'a'.repeat(501) }]);
    c.check('501 chars -> 400', r2.status === 400, `(got ${r2.status})`);
    c.check(
      '501: nothing saved',
      Number((await one(`SELECT COUNT(*) n FROM feedback_responses WHERE assignment_id = ?`, [b.aid])).n) === 0
    );
  }
);

await runCase(
  '4.6',
  41,
  'Unicode, emoji and right-to-left text in free-text feedback',
  'Stored and read back byte-identical from the database, including a 4-byte emoji, a ZWJ sequence, Arabic and Hebrew RTL text and a U+200F RTL mark.',
  async (c) => {
    const text = 'Ünïcödé ✓ 🚀🤖 👩🏽‍💻 مرحبا بالعالم שלום עולם 𝒳 end\u200f';
    const a = await gradedAssignment('unicode');
    const r = await feedback(a.sid, a.aid, [...VALID_FEEDBACK, { question_key: 'comments', value: text }]);
    c.check('accepted', r.status === 200, `(got ${r.status} ${r.text.slice(0, 100)})`);
    const cols = (
      await q(
        `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'feedback_responses'`,
        [DB_NAME]
      )
    ).map((x) => x.c);
    const col = cols.find((x) => /value/.test(x));
    const row = await one(
      `SELECT ${col} v FROM feedback_responses WHERE assignment_id = ? AND question_key = 'comments'`,
      [a.aid]
    );
    c.check('read back identical', row?.v === text, `(col=${col}, got=${JSON.stringify(row?.v)})`);
  }
);

await runCase(
  '4.6',
  42,
  'Slot and assignment IDs that do not exist, are negative, or are not numbers',
  'Non-existent -> 404 (or 403 where the lookup is ownership-scoped); negative, zero, "abc", "1.5" -> 400. Never 5xx.',
  async (c) => {
    const sid = await newCsStudent('badids');
    for (const id of ['999999999', '-1', '0', 'abc', '1.5']) {
      for (const [m, p] of [
        ['POST', `/api/slot/${id}/open`],
        ['GET', `/api/attempts/${id}`],
        ['GET', `/api/assignment/${id}/review`],
        ['POST', `/api/feedback/${id}`],
      ]) {
        const r = await api(m, p, { as: sid, body: m === 'POST' ? { answers: VALID_FEEDBACK } : undefined });
        const want = id === '999999999' ? [403, 404] : [400];
        c.check(`${m} ${p} -> ${want.join('/')}`, want.includes(r.status), `(got ${r.status})`);
      }
      const r = await api('POST', '/api/submit', {
        as: sid,
        body: { assignmentId: /^\d+$/.test(id) ? Number(id) : id, selected: 'a' },
      });
      const want = id === '999999999' ? [403, 404] : [400];
      c.check(`submit assignmentId=${id} -> ${want.join('/')}`, want.includes(r.status), `(got ${r.status})`);
    }
  }
);

// ========================================= 4.7 Failure and recovery ==
await runCase(
  '4.7',
  43,
  'Stop MySQL while a student is mid-submission',
  'With MySQL stopped, the submit returns a 5xx/503 JSON error with a generic message (no stack trace, no DB error text) and the web page shows a recoverable error with the answer still selected. After MySQL is back, retrying with the SAME Idempotency-Key grades exactly once.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const sid = DBDOWN_STUDENT; // single-digit id: the web UI works for it (see case 7)
    const slot = (await weekOf(sid)).slots.find((s) => !s.is_weekly && s.status === 'open');
    const o = await openSlot(sid, slot.slot_id);
    const aid = o.json.assignment_id;
    const k = await answerKey(aid);
    const key = randomUUID();
    // Browser half: page loaded while the DB is up.
    const { ctx, page } = await studentPage(sid);
    await page.goto(`/mission/${slot.slot_id}`);
    await page.locator('input[type=radio]').first().check();
    const stop = await stopMysql();
    c.note(`mysqladmin shutdown exit=${stop.status}`);
    for (let i = 0; i < 40 && (await mysqlUp()); i++) await sleep(250);
    c.check('MySQL is down', !(await mysqlUp()));
    try {
      const r = await submit(sid, aid, k.correct, key);
      c.note(`API submit while down -> ${r.status} in ${r.ms}ms: ${r.text.slice(0, 200)}`);
      c.check('API: 5xx, not 2xx/4xx', r.status >= 500, `(got ${r.status})`);
      c.check('API: JSON error body', !!r.json?.error || !!r.json?.code, `(${r.text.slice(0, 120)})`);
      c.check(
        'API: error does not claim an authentication failure',
        !/auth/i.test(`${r.json?.error?.code} ${r.json?.error?.message}`),
        `(code=${r.json?.error?.code} message="${r.json?.error?.message}")`
      );
      c.check('API: no DB internals in the message', !LEAK_RE.test(r.text), `(${r.text.slice(0, 160)})`);
      await page.getByRole('button', { name: 'Submit answer' }).click();
      await sleep(4000);
      const ui = await page.locator('body').innerText();
      // The whole line: the UI renders `${error.message}. Your answer is safe — try again.`
      const shown = /[^\n]*try again[^\n]*/i.exec(ui)?.[0]?.trim() ?? '';
      c.note(`UI after submit with DB down: url=${page.url().replace(WEB, '')} message="${shown || '(none)'}"`);
      c.check('UI: still on the mission page', /\/mission\//.test(page.url()), `(url=${page.url().replace(WEB, '')})`);
      c.check('UI: shows no result', !/Why this is the answer|Here.s why/.test(ui));
      c.check('UI: shows a visible retry message', !!shown, `(message="${shown || 'none'}")`);
      c.check(
        'UI: message does not blame authentication for a database outage',
        !/authenticat|sign in|log in/i.test(shown),
        `(message="${shown}")`
      );
      c.check('UI: no stack trace / DB text', !LEAK_RE.test(ui));
      c.check(
        'UI: answer still selected (recoverable)',
        await page
          .locator('input[type=radio]')
          .first()
          .isChecked()
          .catch(() => false)
      );
    } finally {
      c.check('MySQL restarted', await startMysql());
    }
    for (let i = 0; i < 60; i++) {
      if ((await api('GET', `/api/week/${sid}`, { as: sid })).status === 200) break;
      await sleep(500);
    }
    const retry = await submit(sid, aid, k.correct, key);
    c.check(
      'retry with the same key grades',
      retry.status === 200 && retry.json?.correct === true,
      `(${retry.status} ${retry.text.slice(0, 120)})`
    );
    c.check(
      'graded exactly once',
      Number((await one(`SELECT COUNT(*) n FROM level_events WHERE assignment_id = ?`, [aid])).n) === 1
    );
    await ctx.close();
    await hook('feedback-gating', { enabled: true });
  }
);

await runCase(
  '4.7',
  44,
  'Stop MySQL while the API is idle, then restart it',
  'Requests during the outage fail fast (under 15s) with a 5xx JSON error. After MySQL restarts, the SAME API process serves requests again within 30s, without being restarted.',
  async (c) => {
    const apiPid = listenerPid(3000);
    await stopMysql();
    const during = await api('GET', '/api/week/1', { as: 1 });
    c.note(`during outage -> ${during.status} in ${during.ms}ms: ${during.text.slice(0, 160)}`);
    c.check('outage request fails fast (<15s)', during.ms < 15000, `(${during.ms}ms)`);
    c.check('outage request is 5xx', during.status >= 500, `(got ${during.status})`);
    c.check('MySQL restarted', await startMysql());
    const t0 = Date.now();
    let back = null;
    while (Date.now() - t0 < 30000) {
      const r = await api('GET', '/api/week/1', { as: 1 });
      if (r.status === 200) {
        back = Date.now() - t0;
        break;
      }
      await sleep(500);
    }
    c.check('API recovered on its own within 30s', back != null, `(after ${back}ms)`);
    c.check(
      'same API process (not restarted)',
      listenerPid(3000) === apiPid,
      `(pid ${apiPid} -> ${listenerPid(3000)})`
    );
  }
);

await runCase(
  '4.7',
  45,
  'Restore the latest backup into a scratch database and run Stage 1 against it',
  'backup.sh (no Docker) takes a verified backup of the live DB; the newest dump in backups/ restores into a scratch DB, db:migrate brings it to the current 11 migrations, and the Stage 1 suite (verify.mjs, 20 checks) passes against an API pointed at that DB.',
  async (c) => {
    const dir = join(ROOT, 'backups');
    // Take a backup now, with the real script, so the case never depends on a
    // leftover file (it used to be NOT TESTED wherever backups/ was empty, CI
    // included, because backup.sh required Docker). Reseed first: Stage 1 judges
    // a freshly seeded database (its student must start at level 0), and the
    // cases before this one leave activity behind that a faithful backup keeps.
    await reseed();
    const bk = spawnSync('bash', ['scripts/backup.sh'], {
      cwd: ROOT,
      env: { ...process.env, BACKUP_DIR: dir },
      encoding: 'utf8',
    });
    c.check(
      'backup.sh takes a backup of the live DB',
      bk.status === 0,
      `(exit ${bk.status} ${(bk.stdout + bk.stderr).trim().slice(-200)})`
    );
    const files = existsSync(dir)
      ? execSync(`ls -1t "${dir}"`, { encoding: 'utf8', shell: 'bash' })
          .split('\n')
          .filter((f) => f.endsWith('.sql.gz'))
      : [];
    if (!files.length)
      return c.notTested('no backup dump exists in backups/ (backup.sh produced none — see the check above)');
    const scratch = 'mission_demo_audit_restore';
    const restoreInto = async (name) => {
      await q(
        `DROP DATABASE IF EXISTS \`${scratch}\`; CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
      );
      const sql = gunzipSync(readFileSync(join(dir, name)));
      const rest = spawnSync(MYSQL_CLIENT, ['-uroot', `-p${DBPASS}`, '--host=127.0.0.1', scratch], {
        input: sql,
        encoding: 'utf8',
      });
      const tables = Number(
        (await one(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [scratch])).n
      );
      return { rest, bytes: sql.length, tables };
    };
    // A. The literal latest backup must actually contain the database.
    const latest = await restoreInto(files[0]);
    c.note(`latest dump: ${files[0]} (${latest.bytes} bytes of SQL, ${latest.tables} tables after restore)`);
    c.check(
      'latest backup contains data',
      latest.bytes > 0 && latest.tables > 0,
      `(${latest.bytes} bytes, ${latest.tables} tables)`
    );
    // B. The newest dump that is not empty, through migrate and Stage 1.
    const usable = files.find((f) => gunzipSync(readFileSync(join(dir, f))).length > 0);
    if (!usable) return c.check('a non-empty backup exists', false);
    c.note(`newest non-empty dump: ${usable}`);
    const { rest } = await restoreInto(usable);
    c.check(
      'restore exit 0',
      rest.status === 0,
      `(${(rest.stderr ?? '').replace(/.*Using a password.*\n?/, '').slice(0, 200)})`
    );
    const before = (await q(`SELECT name FROM \`${scratch}\`.schema_migrations ORDER BY name`).catch(() => [])).map(
      (r) => r.name
    );
    c.note(`migrations in the dump: ${before.length} (${before.at(-1) ?? 'none'})`);
    const mig = spawnSync(process.execPath, ['--import', 'tsx', 'src/migrator.ts', 'up'], {
      cwd: ROOT,
      env: { ...process.env, DB_NAME: scratch },
      encoding: 'utf8',
    });
    c.check('db:migrate on the restore exit 0', mig.status === 0, `(${(mig.stdout + mig.stderr).slice(-200)})`);
    const after = (await q(`SELECT name FROM \`${scratch}\`.schema_migrations`)).length;
    c.check('restore now at 11 migrations', after === 11, `(${after})`);
    const inst = await spawnApi(3015, { DB_NAME: scratch, ENABLE_TEST_HOOKS: '1' });
    try {
      if (!c.check('API on the restored DB started', inst.ok, inst.ok ? '' : inst.log().slice(-200))) return;
      const s1 = spawnSync(process.execPath, ['verify.mjs'], {
        cwd: ROOT,
        env: { ...process.env, BASE_URL: inst.base, DB_NAME: scratch },
        encoding: 'utf8',
      });
      const tally = /====\s*(\d+) passed, (\d+) failed/.exec(s1.stdout ?? '');
      c.note(`Stage 1 on the restore: ${tally ? tally[0] : (s1.stdout + s1.stderr).slice(-300)}`);
      c.check('Stage 1 passes on the restored DB', s1.status === 0 && tally && tally[2] === '0', `(exit ${s1.status})`);
    } finally {
      stopApi(inst);
      await q(`DROP DATABASE IF EXISTS \`${scratch}\``);
    }
  }
);

// =============================================== 4.8 Time and dates ==
async function tzStudent(tag) {
  const sid = await newCsStudent(tag);
  await q(`UPDATE students SET timezone = 'Asia/Kolkata' WHERE id = ?`, [sid]);
  const o = await openSlot(sid, slotByIndex(await weekOf(sid), 1).slot_id);
  return { sid, aid: o.json.assignment_id };
}
/** Insert a 'submitted' log at a LOCAL (Asia/Kolkata) wall-clock time. */
const submittedAt = (sid, aid, localDateTime) =>
  q(
    `INSERT INTO attempt_logs (assignment_id, student_id, event, detail, created_at) VALUES (?, ?, 'submitted', '{}', CONVERT_TZ(?, 'Asia/Kolkata', '+00:00'))`,
    [aid, sid, localDateTime]
  );
const localToday = async () =>
  (await one(`SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'Asia/Kolkata'), '%Y-%m-%d') d`)).d;
const addDays = (iso, n) =>
  new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);

await runCase(
  '4.8',
  46,
  'Asia/Kolkata student submitting at 23:55 and again at 00:05',
  'Submissions at local 23:55 yesterday and 00:05 today fall on the SAME UTC day but two different LOCAL days, so current_streak is 2 (and /api/progress agrees).',
  async (c) => {
    const { sid, aid } = await tzStudent('midnight');
    const today = await localToday();
    await submittedAt(sid, aid, `${addDays(today, -1)} 23:55:00`);
    await submittedAt(sid, aid, `${today} 00:05:00`);
    const utcDays = await q(
      `SELECT DISTINCT DATE(created_at) d FROM attempt_logs WHERE student_id = ? AND event = 'submitted'`,
      [sid]
    );
    c.note(`distinct UTC days = ${utcDays.length}`);
    c.check('computeStreak = 2', (await computeStreak(sid)) === 2, `(got ${await computeStreak(sid)})`);
    const p = await api('GET', `/api/progress/${sid}`, { as: sid });
    c.check('/api/progress current_streak = 2', p.json?.current_streak === 2, `(got ${p.json?.current_streak})`);
  }
);

await runCase(
  '4.8',
  47,
  'A streak that spans a month boundary',
  'A: one submission per local day from the last day of last month through today -> current_streak = day-of-month + 1. B: Dec 30 2025 - Jan 2 2026 (year boundary) -> longest 4, current 0. C: Feb 27 - Mar 1 2024 (leap day) -> longest 4.',
  async (c) => {
    const today = await localToday();
    const dom = Number(today.slice(8, 10));
    const A = await tzStudent('month');
    for (let i = 0; i <= dom; i++) await submittedAt(A.sid, A.aid, `${addDays(today, -i)} 12:00:00`);
    c.check(
      `A current_streak = ${dom + 1}`,
      (await computeStreak(A.sid)) === dom + 1,
      `(got ${await computeStreak(A.sid)})`
    );
    const B = await tzStudent('year');
    for (const d of ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
      await submittedAt(B.sid, B.aid, `${d} 12:00:00`);
    c.check('B longest = 4', (await computeLongestStreak(B.sid)) === 4, `(got ${await computeLongestStreak(B.sid)})`);
    c.check('B current = 0', (await computeStreak(B.sid)) === 0, `(got ${await computeStreak(B.sid)})`);
    const C = await tzStudent('leap');
    for (const d of ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01'])
      await submittedAt(C.sid, C.aid, `${d} 12:00:00`);
    c.check(
      'C longest = 4 across the leap day',
      (await computeLongestStreak(C.sid)) === 4,
      `(got ${await computeLongestStreak(C.sid)})`
    );
  }
);

await runCase(
  '4.8',
  48,
  'time_to_submit_seconds is accurate regardless of the server timezone',
  'For API processes started with TZ = UTC, America/Los_Angeles, Asia/Kolkata and Pacific/Kiritimati (+14), and with MySQL global time_zone set to +05:30: opening a mission, waiting 3s and submitting records time_to_submit_seconds between 2 and 8.',
  async (c) => {
    await hook('feedback-gating', { enabled: false });
    const measure = async (label, overrides) => {
      const inst = await spawnApi(3016, { ENABLE_TEST_HOOKS: '1', ...overrides });
      try {
        if (!c.check(`${label}: instance started`, inst.ok, inst.ok ? '' : inst.log().slice(-200))) return;
        await api('POST', '/api/test/feedback-gating', { base: inst.base, body: { enabled: false } });
        const sid = await newCsStudent(`tz-${label}`);
        const w = await weekOf(sid);
        const o = await api('POST', `/api/slot/${slotByIndex(w, 1).slot_id}/open`, { as: sid, base: inst.base });
        await sleep(3000);
        const k = await answerKey(o.json.assignment_id);
        await api('POST', '/api/submit', {
          as: sid,
          base: inst.base,
          body: { assignmentId: o.json.assignment_id, selected: k.correct },
        });
        const t = Number(
          (await one(`SELECT time_to_submit_seconds t FROM assignments WHERE id = ?`, [o.json.assignment_id])).t
        );
        c.check(`${label}: time_to_submit_seconds in [2, 8]`, t >= 2 && t <= 8, `(got ${t})`);
      } finally {
        stopApi(inst);
      }
    };
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      const probe = spawnSync(process.execPath, ['-e', 'console.log(new Date().getTimezoneOffset())'], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      c.note(`TZ=${tz} -> node getTimezoneOffset() = ${probe.stdout.trim()}`);
      await measure(`TZ=${tz}`, { TZ: tz });
    }
    const orig = (await one(`SELECT @@GLOBAL.time_zone z`)).z;
    try {
      await q(`SET GLOBAL time_zone = '+05:30'`);
      await measure('mysql global +05:30', {});
    } finally {
      await q(`SET GLOBAL time_zone = ?`, [orig]);
    }
    await hook('feedback-gating', { enabled: true });
  }
);

// =================================================== 4.9 UI and themes ==
const SCREENS = ['login', 'week', 'mission', 'feedback', 'progress'];
let uiFix = null;
async function uiFixture() {
  if (uiFix) return uiFix;
  await hook('feedback-gating', { enabled: false });
  const sid = UI_STUDENT;
  const w = await weekOf(sid);
  const first = w.slots.find((s) => !s.is_weekly && s.status === 'open');
  const done = await completeSlot(sid, first.slot_id, true, { fb: false });
  await hook('feedback-gating', { enabled: true });
  const next = (await weekOf(sid)).slots.find((s) => !s.is_weekly && s.status === 'open');
  uiFix = { sid, fbAid: done.aid, openSlot: next.slot_id };
  return uiFix;
}
async function gotoScreen(page, screen) {
  const f = await uiFixture();
  const url = {
    login: '/login',
    week: '/week',
    mission: `/mission/${f.openSlot}`,
    feedback: `/feedback/${f.fbAid}`,
    progress: '/progress',
  }[screen];
  const r = await page.goto(url);
  await page.waitForLoadState('networkidle').catch(() => {});
  return r;
}
async function eachScreen(fn, { widths = [1280] } = {}) {
  const f = await uiFixture();
  for (const theme of ['nebula', 'horizon'])
    for (const width of widths)
      for (const screen of SCREENS) {
        const { ctx, page, errors } = await studentPage(screen === 'login' ? null : f.sid, { theme, width });
        try {
          await gotoScreen(page, screen);
          // Guard: prove the intended theme is what actually rendered, so a
          // result can never be attributed to a theme that was not applied.
          const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          const want = theme === 'horizon' ? 'rgb(250, 250, 250)' : 'rgb(7, 11, 37)';
          if (bg !== want) throw new Error(`theme guard: ${theme} expected body ${want}, got ${bg}`);
          await fn({ page, errors, screen, theme, width });
        } finally {
          await ctx.close();
        }
      }
}
const TW_RE =
  /\b(?:bg|text|border|ring|ring-offset|from|to|via|divide|outline|shadow|accent|caret|decoration|fill|stroke|placeholder)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b|\b(?:bg|text|border)-(?:black|white)\b/;

await runCase(
  '4.9',
  49,
  'Each student screen renders without console errors, in both themes',
  'Zero console errors and zero page errors on login, week, mission, feedback and progress, in nebula and horizon.',
  async (c) => {
    await eachScreen(async ({ page, errors, screen, theme }) => {
      await sleep(500);
      c.check(
        `${theme}/${screen}: no console errors`,
        errors.length === 0,
        errors.length ? `(${errors.slice(0, 2).join(' | ').slice(0, 200)})` : ''
      );
    });
  }
);

await runCase(
  '4.9',
  50,
  'axe scan of each student screen, in both themes',
  'Zero axe violations (WCAG 2.1 A/AA) on each screen in each theme.',
  async (c) => {
    const { AxeBuilder } = await browser();
    await eachScreen(async ({ page, screen, theme }) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      const summary = r.violations.map((v) => `${v.id}x${v.nodes.length}`).join(',');
      c.check(`${theme}/${screen}: 0 violations`, r.violations.length === 0, `(${summary})`);
    });
  }
);

await runCase(
  '4.9',
  51,
  'Keyboard-only completion of a full mission and feedback, in both themes',
  'In each theme a fresh student opens a mission, answers, submits, reaches feedback and submits it, using only the keyboard, ending on "Your next mission is ready".',
  async (c) => {
    // One seeded student for both themes: the first run completes one mission
    // and its feedback, which unlocks the next slot for the second run.
    await hook('feedback-gating', { enabled: true });
    for (const theme of ['nebula', 'horizon']) {
      const sid = KBD_STUDENT;
      await weekOf(sid);
      const { ctx, page } = await studentPage(sid, { theme });
      try {
        await page.goto('/week');
        // The first open daily slot — earlier slots are completed and link to a review.
        const openId = (await weekOf(sid)).slots.find((s) => !s.is_weekly && s.status === 'open')?.slot_id;
        const slot = page.locator(`a[href="/mission/${openId}"]`);
        await slot.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/mission\//, { timeout: 10000 });
        const opt = page.locator('input[type=radio]').first();
        await opt.focus();
        await page.keyboard.press('Space');
        await page.getByRole('button', { name: 'Submit answer' }).focus();
        await page.keyboard.press('Enter');
        await page.getByText(/Why this is the answer|Here.s why/).waitFor({ timeout: 10000 });
        await page.getByRole('button', { name: /Give feedback to continue/ }).focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/feedback\//, { timeout: 10000 });
        for (const key of ['perceived_difficulty', 'time_taken', 'clarity', 'confidence']) {
          const r = page.getByTestId(`fq-${key}`).locator('input[type=radio]').first();
          await r.focus();
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowLeft');
        }
        await page.getByRole('button', { name: 'Submit & continue' }).focus();
        await page.keyboard.press('Enter');
        await page.getByText('Your next mission is ready').waitFor({ timeout: 10000 });
        c.check(`${theme}: completed by keyboard`, true);
      } catch (e) {
        c.check(`${theme}: completed by keyboard`, false, `(${String(e.message).split('\n')[0].slice(0, 160)})`);
      } finally {
        await ctx.close();
      }
    }
  }
);

await runCase(
  '4.9',
  52,
  'Each screen at 360px, 768px and 1280px, in both themes',
  'No horizontal scroll (document scrollWidth <= viewport width) and no visible element extends past the right edge, at every width, screen and theme.',
  async (c) => {
    await eachScreen(
      async ({ page, screen, theme, width }) => {
        const m = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const sw = document.documentElement.scrollWidth;
          // "Cut off" = VISIBLE content past the right edge that the user cannot
          // reach. Excluded: visually-hidden (1px clipped) screen-reader text, and
          // anything inside an overflow-x auto/scroll container, which is
          // reachable by scrolling that container. Page-level sideways scroll is
          // measured separately above, so nothing is hidden by this exclusion.
          const scrollable = (el) => {
            for (let p = el.parentElement; p; p = p.parentElement)
              if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true;
            return false;
          };
          const over = [...document.querySelectorAll('body *')]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && r.right > vw + 1 && !scrollable(el);
            })
            .slice(0, 3)
            .map(
              (el) =>
                `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`
            );
          return { vw, sw, over };
        });
        c.check(
          `${theme}/${screen}@${width}: no horizontal scroll`,
          m.sw <= m.vw,
          `(scrollWidth=${m.sw} viewport=${m.vw})`
        );
        c.check(`${theme}/${screen}@${width}: nothing cut off`, m.over.length === 0, `(${m.over.join(' ; ')})`);
      },
      { widths: [360, 768, 1280] }
    );
  }
);

await runCase(
  '4.9',
  53,
  'No raw Tailwind default colour anywhere in the rendered HTML',
  'The rendered HTML of every screen in both themes contains no Tailwind default-palette class (bg-blue-500 etc.) and no bg-/text-/border-black|white.',
  async (c) => {
    await eachScreen(async ({ page, screen, theme }) => {
      const html = await page.content();
      const m = TW_RE.exec(html);
      c.check(`${theme}/${screen}: none`, !m, m ? `(found "${m[0]}")` : '');
    });
  }
);

await runCase(
  '4.9',
  54,
  'The iframe height message fires when framed, and not when not framed',
  'Framed inside a parent page, the app posts at least one height message (e.g. {subject:"lti.frameResize", height}) to the parent within 5s. Loaded top-level, it posts none.',
  async (c) => {
    const { b } = await browser();
    const ctx = await b.newContext();
    const parent = await ctx.newPage();
    await parent.setContent(
      `<script>window.__msgs=[];addEventListener('message',e=>window.__msgs.push(e.data))</script><iframe src="${WEB}/login" style="width:800px;height:400px"></iframe>`
    );
    await sleep(5000);
    const framed = await parent.evaluate(() => window.__msgs);
    c.check(
      'framed: height message received by the parent',
      framed.some((m) => m && typeof m === 'object' && ('height' in m || m.subject === 'lti.frameResize')),
      `(messages=${JSON.stringify(framed).slice(0, 160)})`
    );
    const top = await ctx.newPage();
    await top.addInitScript(() => {
      window.__msgs = [];
      addEventListener('message', (e) => window.__msgs.push(e.data));
    });
    await top.goto(`${WEB}/login`);
    await sleep(3000);
    const unframed = await top.evaluate(() => window.__msgs);
    c.check(
      'not framed: no height message posted',
      !unframed.some((m) => m && typeof m === 'object' && 'height' in m),
      `(messages=${JSON.stringify(unframed).slice(0, 160)})`
    );
    await ctx.close();
  }
);

await runCase(
  '4.9',
  55,
  'No second header bar present',
  'No screen, in either theme, renders its own <header>/role=banner bar — the LMS page provides the header.',
  async (c) => {
    await eachScreen(async ({ page, screen, theme }) => {
      const n = await page.locator('header, [role=banner]').count();
      c.check(`${theme}/${screen}: no own header bar`, n === 0, `(found ${n})`);
    });
  }
);

// ======================================================== 4.10 Pipeline ==
const TOPICS = ['Chassis', 'Wheels', 'Motors', 'Batteries', 'Switches', 'Sensors', 'Wiring', 'Testing', 'Showcase'];
const sessionBlock = (heading, topic) =>
  `${heading}\n\nIn this session students study ${topic.toLowerCase()} on the robot kit in careful detail. ` +
  `A robot that loops through its control code repeats the same steps many times each second. ` +
  `Understanding ${topic.toLowerCase()} lets students predict how the robot will behave on the track.`;
function projectText(n, headingFor = (i) => `## Session ${i}: ${TOPICS[i - 1]}`) {
  const out = ['# Audit project', 'This project builds a small robot, one session at a time.'];
  for (let i = 1; i <= n; i++) out.push(sessionBlock(headingFor(i), TOPICS[i - 1]));
  return out.join('\n\n');
}
/** Run the real pipeline CLI against an isolated input dir mapped to C1/P<project>. */
function pipelineFor(files, project, extraEnv = {}) {
  const work = mkdtempSync(join(tmpdir(), 'mh-audit-pipe-'));
  const input = join(work, 'input');
  mkdirSync(input, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(input, name), text);
  const map = Object.fromEntries(
    Object.keys(files).map((n) => [n, { subject: 'Robotics', track: "Tesla's Track", credit: 'C1', project }])
  );
  writeFileSync(join(work, 'curriculum.json'), JSON.stringify({ files: map, legacy_files: [] }));
  const env = {
    ...process.env,
    PIPELINE_INPUT_DIR: input,
    PIPELINE_LOGS_DIR: join(work, 'logs'),
    PIPELINE_CURRICULUM_FILE: join(work, 'curriculum.json'),
    LLM_PROVIDER: 'mock',
    PYTHONIOENCODING: 'utf-8',
    ...extraEnv,
  };
  const run = (...args) => {
    const r = spawnSync(VENV_PY, ['-m', 'src.main', ...args], { cwd: join(ROOT, 'pipeline'), env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return {
    work,
    input,
    run,
    write: (name, text) => writeFileSync(join(input, name), text),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}
const chunksFor = (file) =>
  q(`SELECT id, chunk_ref, session_id, content_hash FROM content_chunks WHERE source_file = ? ORDER BY id`, [file]);
const missionsFor = (file) =>
  q(
    `SELECT m.id, m.status, m.session_id, c.chunk_ref FROM missions m JOIN content_chunks c ON c.id = m.source_chunk_id WHERE c.source_file = ? ORDER BY m.id`,
    [file]
  );
const fullRun = (p) => ['ingest', 'generate', 'validate', 'import'].map((s) => ({ s, ...p.run(s) }));

await runCase(
  '4.10',
  56,
  'A project file with correct session headings',
  'All 9 "## Session n:" headings of a C1/P1 file are detected; every chunk carries the session_id of C1/P1/Sn; ingest -> generate -> validate -> import all exit 0 and every imported mission carries its chunk\'s session_id, as a draft.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f = `audit56-${Date.now()}.md`;
    const p = pipelineFor({ [f]: projectText(9) }, 1);
    try {
      for (const r of fullRun(p)) c.check(`${r.s} exit 0`, r.code === 0, r.code ? `(${r.out.slice(-200)})` : '');
      const ch = await chunksFor(f);
      c.check('9 chunks', ch.length === 9, `(${ch.length})`);
      let wrong = 0;
      for (const x of ch) {
        const n = Number(/Session (\d+)/.exec(x.chunk_ref)?.[1]);
        if (x.session_id !== (await cur.findSession(trackId, 'C1', 1, n))) wrong++;
      }
      c.check('every chunk tagged with its own session', wrong === 0, `(wrong=${wrong})`);
      const ms = await missionsFor(f);
      c.check('missions imported', ms.length > 0, `(${ms.length})`);
      c.check(
        'each mission carries its chunk session_id',
        ms.every((m) => ch.find((x) => x.chunk_ref === m.chunk_ref)?.session_id === m.session_id)
      );
      c.check(
        'all drafts, none live',
        ms.every((m) => m.status === 'draft'),
        `(${[...new Set(ms.map((m) => m.status))]})`
      );
    } finally {
      p.cleanup();
    }
  }
);

await runCase(
  '4.10',
  57,
  'A project file whose session count does not match its definition',
  'A C1/P2 file (8 sessions defined) containing 7 sessions: ingest exits non-zero, the error names the file and both counts, and no content_chunks row is stored for it.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f = `audit57-${Date.now()}.md`;
    const p = pipelineFor({ [f]: projectText(7) }, 2);
    try {
      const r = p.run('ingest');
      c.check('ingest exits non-zero', r.code !== 0, `(exit ${r.code})`);
      c.check('error names the file', r.out.includes(f));
      c.check(
        'error names 8 and 7',
        /\b8\b/.test(r.out) && /\b7\b/.test(r.out),
        `(${r.out.replace(/\s+/g, ' ').slice(-220)})`
      );
      c.check('nothing stored', (await chunksFor(f)).length === 0);
    } finally {
      p.cleanup();
    }
  }
);

await runCase(
  '4.10',
  58,
  'A file with no headings at all',
  'Rejected loudly at ingest (non-zero exit, message naming the file and that no sessions were found), nothing stored.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f = `audit58-${Date.now()}.md`;
    const p = pipelineFor(
      {
        [f]: TOPICS.slice(0, 8)
          .map((t) => sessionBlock('', t))
          .join('\n\n'),
      },
      2
    );
    try {
      const r = p.run('ingest');
      c.note(`ingest output: ${r.out.replace(/\s+/g, ' ').slice(-240)}`);
      c.check('ingest exits non-zero', r.code !== 0, `(exit ${r.code})`);
      c.check('message names the file', r.out.includes(f));
      c.check('nothing stored', (await chunksFor(f)).length === 0);
    } finally {
      p.cleanup();
    }
  }
);

await runCase(
  '4.10',
  59,
  'Session headings in an unexpected format ("SESSION-3", "Sess 5")',
  'The two malformed headings are not silently absorbed into a neighbouring session: the file (C1/P3, 8 sessions) is rejected at ingest with the sessions actually found, and nothing is stored. A file using "SESSION-n" throughout is likewise rejected.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f1 = `audit59a-${Date.now()}.md`;
    const f2 = `audit59b-${Date.now()}.md`;
    const mixed = projectText(8, (i) =>
      i === 3 ? `## SESSION-3: ${TOPICS[2]}` : i === 5 ? `## Sess 5: ${TOPICS[4]}` : `## Session ${i}: ${TOPICS[i - 1]}`
    );
    const allBad = projectText(8, (i) => `## SESSION-${i}: ${TOPICS[i - 1]}`);
    for (const [f, text, label] of [
      [f1, mixed, 'mixed'],
      [f2, allBad, 'all SESSION-n'],
    ]) {
      const p = pipelineFor({ [f]: text }, 3);
      try {
        const r = p.run('ingest');
        c.note(`${label}: ${r.out.replace(/\s+/g, ' ').slice(-200)}`);
        c.check(`${label}: rejected (non-zero exit)`, r.code !== 0, `(exit ${r.code})`);
        c.check(
          `${label}: nothing stored`,
          (await chunksFor(f)).length === 0,
          `(chunks=${(await chunksFor(f)).length})`
        );
      } finally {
        p.cleanup();
      }
    }
  }
);

await runCase(
  '4.10',
  60,
  'The same file ingested twice',
  'The second full run (ingest -> generate -> validate -> import) is a no-op: the same chunk rows with the same hashes, and no new missions.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f = `audit60-${Date.now()}.md`;
    const p = pipelineFor({ [f]: projectText(9) }, 1);
    try {
      fullRun(p);
      const ch1 = await chunksFor(f);
      const m1 = await missionsFor(f);
      const second = fullRun(p);
      c.check(
        'second run exits 0 throughout',
        second.every((r) => r.code === 0),
        `(${second.map((r) => `${r.s}=${r.code}`)})`
      );
      const ch2 = await chunksFor(f);
      const m2 = await missionsFor(f);
      c.check(
        'same chunk rows and hashes',
        JSON.stringify(ch1) === JSON.stringify(ch2),
        `(${ch1.length} -> ${ch2.length})`
      );
      c.check('no new missions', m2.length === m1.length, `(${m1.length} -> ${m2.length})`);
    } finally {
      p.cleanup();
    }
  }
);

await runCase(
  '4.10',
  61,
  'One session edited and re-ingested',
  'After editing only Session 4 and re-running the pipeline: every previous Session 4 mission is retired and new Session 4 drafts exist; missions of every other session keep the same ids and status.',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const f = `audit61-${Date.now()}.md`;
    const p = pipelineFor({ [f]: projectText(9) }, 1);
    try {
      fullRun(p);
      const before = await missionsFor(f);
      const is4 = (m) => /Session 4\b/.test(m.chunk_ref);
      p.write(
        f,
        projectText(9).replace('students study batteries', 'students study rechargeable batteries and charging safety')
      );
      const r = fullRun(p);
      c.check(
        're-run exits 0',
        r.every((x) => x.code === 0),
        `(${r.map((x) => `${x.s}=${x.code}`)})`
      );
      const all = await q(
        `SELECT m.id, m.status, c.chunk_ref FROM missions m JOIN content_chunks c ON c.id = m.source_chunk_id WHERE c.source_file = ?`,
        [f]
      );
      const old4 = before.filter(is4);
      c.check(
        'old Session 4 missions all retired',
        old4.length > 0 && old4.every((m) => all.find((x) => x.id === m.id)?.status === 'retired'),
        `(old4=${old4.length}, statuses=${old4.map((m) => all.find((x) => x.id === m.id)?.status)})`
      );
      const new4 = all.filter((m) => is4(m) && !old4.some((o) => o.id === m.id));
      c.check(
        'new Session 4 drafts created',
        new4.length > 0 && new4.every((m) => m.status === 'draft'),
        `(new=${new4.length})`
      );
      const others = before.filter((m) => !is4(m));
      c.check(
        'other sessions untouched',
        others.every((m) => all.find((x) => x.id === m.id)?.status === m.status),
        `(changed=${others.filter((m) => all.find((x) => x.id === m.id)?.status !== m.status).length})`
      );
    } finally {
      p.cleanup();
    }
  }
);

await runCase(
  '4.10',
  62,
  'The pipeline run against a database missing a migration',
  'Against a scratch DB migrated to 009 only (010 and later never applied): the pipeline exits non-zero with a FATAL message naming the missing objects and "npm run db:migrate", and the scratch schema is unchanged afterwards (content_chunks still absent).',
  async (c) => {
    if (!VENV_PY) return c.notTested('pipeline/.venv not found');
    const scratch = 'mission_demo_audit_nomig';
    await q(`DROP DATABASE IF EXISTS \`${scratch}\`; CREATE DATABASE \`${scratch}\``);
    // Migrate to exactly 009 by NAME. ("up, then down once" meant "at 009" only
    // while 010 was the newest migration; with 011 it left 010 applied.)
    const mpool = makePool(scratch);
    let last = null;
    try {
      await buildUmzug(mpool).up({ to: '009_curriculum' });
      last = (await mpool.query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`))[0][0]?.name;
    } finally {
      await mpool.end();
    }
    c.check(
      'scratch prepared (migrated to 009_curriculum, nothing later)',
      last === '009_curriculum',
      `(last=${last})`
    );
    const schema = async () =>
      (
        await q(
          `SELECT CONCAT(TABLE_NAME,'.',COLUMN_NAME) x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY 1`,
          [scratch]
        )
      )
        .map((r) => r.x)
        .join(',');
    const before = await schema();
    const p = pipelineFor({ 'x.md': projectText(9) }, 1, { DB_NAME: scratch });
    try {
      const r = p.run('ingest');
      c.note(`output: ${r.out.replace(/\s+/g, ' ').slice(-260)}`);
      c.check('exits non-zero', r.code !== 0, `(exit ${r.code})`);
      c.check(
        'FATAL message names content_chunks and db:migrate',
        /FATAL/.test(r.out) && /content_chunks/.test(r.out) && /db:migrate/.test(r.out)
      );
      c.check('schema unchanged', (await schema()) === before);
      c.check('content_chunks still absent', !(await schema()).includes('content_chunks.'));
    } finally {
      p.cleanup();
      await q(`DROP DATABASE IF EXISTS \`${scratch}\``);
    }
  }
);

// ============================================================ RUN THEM ==
{
  const selected = CASES.filter((k) => !ONLY.length || ONLY.includes(k.section));
  const order = SHUFFLE_SEED == null ? selected : shuffled(selected, SHUFFLE_SEED);
  if (SHUFFLE_SEED != null) {
    console.log(`\nSHUFFLED ORDER (seed ${SHUFFLE_SEED}): ${order.map((k) => k.id).join(', ')}`);
  }
  for (const kase of order) {
    await applyState(kase.state);
    await execCase(kase);
  }
  // Report in case-number order however they ran, so two runs can be compared.
  results.sort((a, b) => a.id - b.id);
}

// ================================================================= report ==
if (pw) await pw.b.close();
await hook('selection-mode', { mode: 'legacy' });
await hook('feedback-gating', { enabled: true });
await hook('curriculum-config', { poolLookbackSessions: 0, percentScope: 'credit', revisionMixPercent: 20 });
await hook('reset-rate-limit');
if (!ONLY.length) await reseed().catch((e) => console.log(`(final reseed failed: ${e.message})`));

const count = (s) => results.filter((r) => r.state === s).length;
console.log('\n================ AUDIT RESULTS ================');
for (const r of results) console.log(`  [${String(r.id).padStart(2)}] ${r.state.padEnd(10)} ${r.title}`);
console.log(
  `\n==== Audit: ${count('VERIFIED')} verified, ${count('FAILED')} failed, ${count('NOT TESTED')} not tested ====`
);
const out = join(tmpdir(), `verify-audit-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`results: ${out}`);

// In GitHub Actions: the result as ONE annotation (readable on the run without
// repository-admin rights, unlike job logs; GitHub caps a step at 10 error
// annotations, so one-per-case would truncate) and as a job-summary table.
if (process.env.GITHUB_ACTIONS) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  // A property value (the title) must also escape ',' and ':' — an unescaped
  // comma ends the property, which truncated the title at "verified,".
  const escProp = (s) => esc(s).replace(/,/g, '%2C').replace(/:/g, '%3A');
  const notOk = results.filter((r) => r.state !== 'VERIFIED');
  const lines = notOk.map((r) => {
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name} ${c.detail}`.trim().slice(0, 160));
    return `[${r.id}] ${r.state} ${r.title}${r.why ? ` — ${r.why}` : ''}${failed.length ? ` :: ${failed.join(' | ')}` : ''}`;
  });
  const head = `${count('VERIFIED')} verified, ${count('FAILED')} failed, ${count('NOT TESTED')} not tested`;
  console.log(
    `::${count('FAILED') ? 'error' : 'notice'} title=${escProp(`Audit: ${head}`)}::${esc(lines.join('\n') || 'all cases verified')}`
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = results.map((r) => `| ${r.id} | ${r.state} | ${r.title.replace(/\|/g, '\\|')} |`).join('\n');
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Audit: ${head}\n\n| # | State | Case |\n|---|---|---|\n${table}\n`,
      { flag: 'a' }
    );
  }
}
await db.end();
await pool.end();
process.exitCode = count('FAILED') ? 1 : 0;
