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

/**
 * Student ids that straddle the base64 padding boundaries of the session cookie
 * (seeded by src/seed.ts::seedBoundaryStudents). The web tier once corrupted
 * padded cookies, bouncing every student whose id had the "wrong" number of
 * digits to /login; the seed only had ids 1-9, which all fell on one side, so
 * nothing caught it. Every student journey runs for all of these.
 */
export const BOUNDARY_IDS = [10, 99, 100, 999, 1000, 9999, 10000, 100000] as const;

/** A journey's original student first (unchanged), then every boundary student. */
export function spreadFrom(originalId: number): number[] {
  return [originalId, ...BOUNDARY_IDS];
}

/** The original student keeps the original test title exactly. */
export function titleFor(title: string, id: number, originalId: number): string {
  return id === originalId ? title : `${title} [student ${id}]`;
}
