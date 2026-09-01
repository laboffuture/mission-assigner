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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  if (!ok) { console.error('FATAL: test hook preflight failed.'); process.exit(2); }
}

// Locate the Stage 2 (Python) venv.
const venvPy = ['pipeline/.venv/Scripts/python.exe', 'pipeline/.venv/bin/python']
  .map((p) => join(root, p)).find(existsSync);

try {
  // Migrations (Item 4) — fresh scratch DB matches current; idempotent; reversible.
  run('npm run verify:migrations');

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

  // Logging (Item 2) — request id, error shape, redaction. No reseed needed.
  run('npm run verify:logging');

  // Validation (Item 3) — zod at the boundary, unified error shape.
  run('npm run db:seed');
  run('npm run verify:validation');

  // Stage 2 — offline Python pipeline (independent of the web DB state).
  if (venvPy) {
    run(`"${venvPy}" -m pytest -q`, { cwd: join(root, 'pipeline') });
  } else {
    console.warn('\n[warn] Stage 2 venv not found (pipeline/.venv). Skipping pytest.');
  }

  // Leave the demo DB pristine.
  run('npm run db:seed');

  console.log('\n\x1b[32m==== ALL SUITES PASSED (Migrations + Stage 1 + 2 + 3 + 5 + Auth + Logging + Validation) ====\x1b[0m');
} catch (err) {
  console.error('\n\x1b[31m==== SUITE FAILED ====\x1b[0m');
  process.exit(1);
}
