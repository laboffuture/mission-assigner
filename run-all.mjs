// Single-pass runner for the whole test suite: Stage 1 + Stage 2 + Stage 3 +
// Stage 5, all green in one command with no manual config change.
//
// Each harness injects its own FEEDBACK_GATES_UNLOCK value (Stage 3 -> false,
// Stage 5 -> true) via the guarded /api/test/feedback-gating hook and the
// in-process config setter, so the Stage 3 / Stage 5 conflict is resolved
// without editing env or restarting the server.
//
// Requires: MySQL up, and the dev server running on :3000 WITH ENABLE_TEST_HOOKS=1.
// Run:  npm run verify:all
import { execSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';

// Preflight: server up + test hooks enabled.
{
  let ok = false;
  try {
    const r = await fetch(BASE + '/api/test/feedback-gating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    ok = r.status === 200;
    if (r.status === 403) {
      console.error('FATAL: server is running WITHOUT ENABLE_TEST_HOOKS=1.');
      console.error('Restart it with:  ENABLE_TEST_HOOKS=1 npm run dev');
      process.exit(2);
    }
  } catch {
    console.error(`FATAL: no server on ${BASE}. Start it with:  ENABLE_TEST_HOOKS=1 npm run dev`);
    process.exit(2);
  }
  if (!ok) {
    console.error('FATAL: test hook preflight failed.');
    process.exit(2);
  }
}

// Locate the Stage 2 (Python) venv.
const venvPy = ['pipeline/.venv/Scripts/python.exe', 'pipeline/.venv/bin/python']
  .map((p) => join(root, p))
  .find(existsSync);

// ---------------------------------------------------------------------------
// The suites, as data.
//
// `db` says what a suite does to the SHARED development database:
//   'shared'  — reads and writes it, and is preceded by a reseed. These cannot
//               run beside anything else touching that database.
//   'own'     — works only in a scratch database it creates and drops, or in a
//               server it spawns against one.
//   'none'    — no database at all.
// Only 'own' and 'none' suites are safe to run concurrently; see runPool below.
// ---------------------------------------------------------------------------
const SUITES = [
  // Own scratch database (mm_migr_scratch); never touches :3000.
  { name: 'migrations', cmd: 'npm run verify:migrations', db: 'own' },
  // Own scratch databases (mission_demo_bkp*) and its own temp server on :3999.
  { name: 'backups', cmd: 'npm run verify:backups', db: 'own' },
  // Writes students into the SHARED database and seeds it when empty.
  { name: 'ops', cmd: 'npm run verify:ops', db: 'shared' },
  { name: 'stage1', cmd: 'npm run verify', db: 'shared', seed: true },
  { name: 'stage3', cmd: 'npm run verify:stage3', db: 'shared', seed: true },
  { name: 'stage5', cmd: 'npm run verify:stage5', db: 'shared', seed: true },
  { name: 'auth', cmd: 'npm run verify:auth', db: 'shared', seed: true },
  { name: 'staff-auth', cmd: 'npm run verify:staff-auth', db: 'shared', seed: true },
  { name: 'api-shape', cmd: 'npm run verify:api-shape', db: 'shared', seed: true },
  { name: 'assistance', cmd: 'npm run verify:assistance', db: 'shared', seed: true },
  { name: 'review', cmd: 'npm run verify:review', db: 'shared', seed: true },
  { name: 'csrf', cmd: 'npm run verify:csrf', db: 'none' },
  { name: 'login-ratelimit', cmd: 'npm run verify:login-ratelimit', db: 'shared' },
  // Drives the live server on :3000.
  { name: 'cookie-flags', cmd: 'npm run verify:cookie-flags', db: 'shared' },
  { name: 'logging', cmd: 'npm run verify:logging', db: 'shared' },
  { name: 'validation', cmd: 'npm run verify:validation', db: 'shared', seed: true },
  { name: 'config', cmd: 'npm run verify:config', db: 'none' },
  // Runs db:seed twice — it rewrites the shared database.
  { name: 'prod-guard', cmd: 'npm run verify:prod-guard', db: 'shared' },
  // Scratch database for the boot cases, but the session cases use the live
  // server on :3000, and it reseeds.
  { name: 'fail-closed', cmd: 'npm run verify:fail-closed', db: 'shared' },
  { name: 'correctness', cmd: 'npm run verify:correctness', db: 'shared', seed: true },
  { name: 'timezone', cmd: 'npm run verify:timezone', db: 'shared', seed: true },
  { name: 'concurrency', cmd: 'npm run verify:concurrency', db: 'shared', seed: true },
  { name: 'pagination', cmd: 'npm run verify:pagination', db: 'shared', seed: true },
  { name: 'curriculum', cmd: 'npm run verify:curriculum', db: 'shared', seed: true },
  ...(venvPy
    ? [
        { name: 'pytest', cmd: `"${venvPy}" -m pytest -q`, cwd: join(root, 'pipeline'), db: 'none' },
        { name: 'curriculum-pipeline', cmd: 'npm run verify:curriculum-pipeline', db: 'shared', seed: true },
      ]
    : []),
];

// ---------------------------------------------------------------------------
// Measurement. Wall time is easy; memory is the number that has actually hurt
// (the suite has been killed for it), so it is sampled rather than guessed.
//
// On Linux (CI) the sampler reads /proc: the resident size of every node,
// python and tsx process, which is what grows when a harness spawns servers.
// Elsewhere it reports null rather than a number it cannot stand behind.
// ---------------------------------------------------------------------------
const MEASURE_MS = 250;

function rssTotalKb() {
  if (process.platform !== 'linux') return null;
  let total = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (!/^(node|python3?|tsx)$/.test(comm)) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) total += Number(m[1]);
    } catch {
      /* the process exited between readdir and read; ignore it */
    }
  }
  return total;
}

const results = [];

// A harness that leaks does not get to take the machine with it. 640MB is
// generous: the whole suite peaks around 320MB across every process, so this
// only ever bites a runaway. Override with SUITE_HEAP_MB.
const HEAP_MB = Number(process.env.SUITE_HEAP_MB) || 640;
const childEnv = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${HEAP_MB}`.trim(),
};

function run(cmd, opts = {}) {
  console.log(`\n\x1b[36m$ ${cmd}\x1b[0m`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: opts.cwd ?? root, env: childEnv });
  } catch (err) {
    // In CI the job log needs repository-admin rights to read, so a failure
    // visible only there is invisible to everyone else. Name the suite in an
    // annotation, which anyone can see on the run.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Suite failed::${cmd}`);
    throw err;
  }
}

/**
 * Run a command without blocking the event loop, buffering its output so two
 * concurrent suites cannot interleave into an unreadable mess. The buffer is
 * printed when the suite finishes, under its own heading.
 */
function runAsync(suite) {
  return new Promise((resolve) => {
    const child = spawn(suite.cmd, {
      cwd: suite.cwd ?? root,
      env: childEnv,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Run one suite, recording how long it took and how much memory it cost. */
function runMeasured(suite) {
  let peakKb = rssTotalKb();
  const sampler =
    peakKb == null
      ? null
      : setInterval(() => {
          const now = rssTotalKb();
          if (now != null && now > peakKb) peakKb = now;
        }, MEASURE_MS);
  const started = Date.now();
  try {
    run(suite.cmd, { cwd: suite.cwd });
    return true;
  } finally {
    if (sampler) clearInterval(sampler);
    results.push({ name: suite.name, db: suite.db, ms: Date.now() - started, peakKb });
  }
}

/**
 * Run the isolated suites concurrently, alongside whatever the main thread is
 * doing. "Isolated" is not a guess: each suite is labelled by what it touches
 * (see SUITES), and only those with no claim on the shared database or the live
 * server on :3000 are in here. Ports do not collide either — csrf binds an
 * ephemeral port, backups uses :3999, and migrations, config and pytest bind
 * nothing.
 */
function startIsolatedPool(suites, concurrency = 3) {
  const queue = [...suites];
  const failures = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let suite = queue.shift(); suite; suite = queue.shift()) {
      const started = Date.now();
      const { code, out } = await runAsync(suite);
      results.push({ name: suite.name, db: suite.db, ms: Date.now() - started, peakKb: null, parallel: true });
      console.log(`\n\x1b[36m$ ${suite.cmd}\x1b[0m  (ran in parallel)`);
      process.stdout.write(out.endsWith('\n') ? out : out + '\n');
      if (code !== 0) {
        failures.push(suite.name);
        if (process.env.GITHUB_ACTIONS) console.log(`::error title=Suite failed::${suite.cmd}`);
      }
    }
  });
  return Promise.all(workers).then(() => failures);
}

function report() {
  if (results.length === 0) return;
  const total = results.reduce((n, r) => n + r.ms, 0);
  const peak = results.reduce((n, r) => Math.max(n, r.peakKb ?? 0), 0);
  const rows = [...results].sort((a, b) => b.ms - a.ms);
  console.log('\n==== suite cost (slowest first) ====');
  console.log(`${'suite'.padEnd(22)}${'db'.padEnd(8)}${'seconds'.padStart(8)}${'peak MB'.padStart(10)}`);
  for (const r of rows) {
    const mb = r.peakKb == null ? '     n/a' : (r.peakKb / 1024).toFixed(0).padStart(8);
    console.log(`${r.name.padEnd(22)}${r.db.padEnd(8)}${(r.ms / 1000).toFixed(1).padStart(8)}${mb.padStart(10)}`);
  }
  console.log(
    `\n${'TOTAL'.padEnd(22)}${''.padEnd(8)}${(total / 1000).toFixed(1).padStart(8)}` +
      `${(peak ? (peak / 1024).toFixed(0) : 'n/a').padStart(10)}  (peak is the highest single sample, not a sum)`
  );
  if (peak === 0) console.log('  (memory not sampled: /proc is Linux-only)');
  // Job logs need repository-admin rights to read, so the numbers would be
  // invisible to anyone who cannot open them. An annotation is public to anyone
  // who can see the run.
  if (process.env.GITHUB_ACTIONS) {
    const line = rows
      .map(
        (r) =>
          `${r.name} ${(r.ms / 1000).toFixed(1)}s/${r.peakKb == null ? 'n/a' : (r.peakKb / 1024).toFixed(0) + 'MB'}`
      )
      .join('; ');
    console.log(
      `::notice title=Suite cost::total ${(total / 1000).toFixed(1)}s, peak ` +
        `${peak ? (peak / 1024).toFixed(0) + 'MB' : 'n/a'} — ${line}`
    );
  }
}

try {
  // The isolated suites start immediately and run beside the serial chain; the
  // shared-database ones cannot, because each is preceded by a reseed that would
  // pull the database out from under anything else using it.
  const isolated = SUITES.filter((s) => s.db !== 'shared');
  const serial = SUITES.filter((s) => s.db === 'shared');
  const pool = startIsolatedPool(isolated);

  let seedMs = 0;
  let seeds = 0;
  for (const suite of serial) {
    if (suite.seed) {
      const t = Date.now();
      run('npm run db:seed');
      seedMs += Date.now() - t;
      seeds++;
    }
    runMeasured(suite);
  }

  const poolFailures = await pool;

  // Leave the demo DB pristine.
  const t = Date.now();
  run('npm run db:seed');
  seedMs += Date.now() - t;
  seeds++;
  results.push({ name: `(${seeds} reseeds)`, db: 'shared', ms: seedMs, peakKb: null, seedRow: true });

  if (poolFailures.length) {
    throw new Error(`parallel suite(s) failed: ${poolFailures.join(', ')}`);
  }
  report();
  console.log(
    '\n\x1b[32m==== ALL SUITES PASSED (Migrations + Stage 1 + 2 + 3 + 5 + Auth + Logging + Validation + Config + Curriculum) ====\x1b[0m'
  );
} catch (err) {
  report();
  console.error('\n\x1b[31m==== SUITE FAILED ====\x1b[0m');
  process.exit(1);
}
