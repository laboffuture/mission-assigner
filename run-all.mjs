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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';

function run(cmd, opts = {}) {
  console.log(`\n\x1b[36m$ ${cmd}\x1b[0m`);
  execSync(cmd, { stdio: 'inherit', cwd: opts.cwd ?? root });
}

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

try {
  // Migrations (Item 4) — fresh scratch DB matches current; idempotent; reversible,
  // including every down step on a seeded database.
  run('npm run verify:migrations');

  // Backups — no Docker; a failed dump leaves no file; restore refuses an invalid
  // backup before dropping; backup:verify passes end to end and cleans up.
  run('npm run verify:backups');

  // Stage 1 — free-play loop (gating irrelevant).
  run('npm run db:seed');
  run('npm run verify');

  // Stage 3 — the harness sets gating OFF for itself.
  run('npm run db:seed');
  run('npm run verify:stage3');

  // Stage 5 — the harness sets gating ON for itself.
  run('npm run db:seed');
  run('npm run verify:stage5');

  // Auth (Item 1) — role/ownership enforcement.
  run('npm run db:seed');
  run('npm run verify:auth');

  // Staff login — username/password → signed session cookie, /api/me, logout.
  run('npm run db:seed');
  run('npm run verify:staff-auth');

  // API surface adjustments — dev/login-as sets the real session cookie, and
  // list endpoints return a uniform { items } envelope.
  run('npm run db:seed');
  run('npm run verify:api-shape');

  // Instructor assistance queue — list/detail/acknowledge/resolve, role-gated.
  run('npm run db:seed');
  run('npm run verify:assistance');

  // Mission review — a student reviews their own completed assignment.
  run('npm run db:seed');
  run('npm run verify:review');

  // CSRF — double-submit token issue + enforcement (in-process; no server/DB).
  run('npm run verify:csrf');

  // Login rate limit — 5 failures/username/15min → 429, no existence leak.
  // (Resets the in-memory limiter at the end so later logins are unaffected.)
  run('npm run verify:login-ratelimit');

  // Session cookie flags — HttpOnly / SameSite / Secure policy across envs.
  run('npm run verify:cookie-flags');

  // Logging (Item 2) — request id, error shape, redaction. No reseed needed.
  run('npm run verify:logging');

  // Validation (Item 3) — zod at the boundary, unified error shape.
  run('npm run db:seed');
  run('npm run verify:validation');

  // Config validation (Item 6) — refuses to start on bad env.
  run('npm run verify:config');

  // Production security guard — refuses to boot in production while any staff
  // account still has the default password. (Reseeds itself at the end.)
  run('npm run verify:prod-guard');

  // Production fails closed: refused boots, refused destructive commands, server-side session expiry.
  run('npm run verify:fail-closed');

  // Correctness (Phase 5): outage is 503 not auth; LTI stub 401; idempotency key
  // bound to its body; answer must be a real option; /quality gated; log levels.
  run('npm run db:seed');
  run('npm run verify:correctness');

  // Timezone (Item 7) — UTC storage, SQL time math, per-student streak boundary.
  run('npm run db:seed');
  run('npm run verify:timezone');

  // Concurrency (Item 8) — idempotency key + row-lock; no double grade/XP/unlock.
  run('npm run db:seed');
  run('npm run verify:concurrency');

  // Pagination (Item 9) — cursor-based list endpoints.
  run('npm run db:seed');
  run('npm run verify:pagination');

  // Curriculum selection — position-scoped pools, SQL ceiling, exhaustion ladder,
  // percent derivation. Sets SELECTION_MODE=curriculum for its own run.
  run('npm run db:seed');
  run('npm run verify:curriculum');

  // Stage 2 — offline Python pipeline (independent of the web DB state).
  if (venvPy) {
    run(`"${venvPy}" -m pytest -q`, { cwd: join(root, 'pipeline') });
    // Session-aware ingest → import against the real DB, with the mock LLM.
    run('npm run db:seed');
    run('npm run verify:curriculum-pipeline');
  } else {
    console.warn(
      '\n[warn] Stage 2 venv not found (pipeline/.venv). Skipping pytest and the curriculum pipeline suite.'
    );
  }

  // Leave the demo DB pristine.
  run('npm run db:seed');

  console.log(
    '\n\x1b[32m==== ALL SUITES PASSED (Migrations + Stage 1 + 2 + 3 + 5 + Auth + Logging + Validation + Config + Curriculum) ====\x1b[0m'
  );
} catch (err) {
  console.error('\n\x1b[31m==== SUITE FAILED ====\x1b[0m');
  process.exit(1);
}
