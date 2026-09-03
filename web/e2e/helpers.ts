import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

/** mission-demo repo root (web/e2e -> web -> mission-demo). CJS __dirname (see e2e/package.json). */
const repoRoot = resolve(__dirname, '..', '..');

/** Reset the DB to the known seed so each spec starts from deterministic state. */
export function seedDb(): void {
  execSync('npm run db:seed', { cwd: repoRoot, stdio: 'ignore' });
}

/**
 * Sign in as a student via the dev launch endpoint. Uses page.request so the
 * session cookie lands in the browser context and subsequent navigations are
 * authenticated — the same session path the LTI launch will use.
 */
export async function loginAs(page: Page, studentId: number): Promise<void> {
  const res = await page.request.post('/api/dev/login-as', { data: { studentId } });
  if (!res.ok()) throw new Error(`login-as ${studentId} failed: ${res.status()}`);
}

/**
 * Force the shared server's feedback-gating flag to a known value so tests don't
 * depend on whatever state a previous run left it in (the flag is process-global
 * and runtime-injectable via this dev hook).
 */
export async function setFeedbackGating(page: Page, enabled: boolean): Promise<void> {
  const res = await page.request.post('/api/test/feedback-gating', { data: { enabled } });
  if (!res.ok()) throw new Error(`feedback-gating toggle failed: ${res.status()}`);
}
