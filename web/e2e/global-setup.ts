/**
 * The e2e specs drive the seeded Computer Science students, who have no
 * curriculum position. They were written for difficulty + interest selection, so
 * the shared API server is put in legacy mode once before any spec runs.
 */
export default async function globalSetup(): Promise<void> {
  const api = process.env.API_ORIGIN ?? 'http://localhost:3000';
  const res = await fetch(`${api}/api/test/selection-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'legacy' }),
  });
  if (!res.ok) {
    throw new Error(
      `could not set SELECTION_MODE=legacy on ${api} (HTTP ${res.status}); start the API with ENABLE_TEST_HOOKS=1`
    );
  }
}
