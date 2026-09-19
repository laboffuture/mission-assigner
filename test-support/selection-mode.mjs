// Shared by the HTTP harnesses: set the running server's SELECTION_MODE for this
// suite's run, the same way the Stage 3/5 harnesses set feedback gating. Every
// suite written before curriculum selection asks for 'legacy'; the curriculum
// suites ask for 'curriculum'. That is what lets the whole run go green in one pass.
//
// If the server runs without ENABLE_TEST_HOOKS (e.g. the backup-verify temp
// server) the hook 403s; we then assume the server was started with the matching
// SELECTION_MODE env var and say so, rather than failing before the suite runs.
export async function useSelectionMode(mode, base = process.env.BASE_URL ?? 'http://localhost:3000') {
  const res = await fetch(`${base}/api/test/selection-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (res.status === 403) {
    console.log(`  [note] test hooks disabled on ${base}; assuming the server runs with SELECTION_MODE=${mode}`);
    return false;
  }
  if (!res.ok) throw new Error(`could not set selection mode '${mode}' on ${base}: HTTP ${res.status}`);
  return true;
}
