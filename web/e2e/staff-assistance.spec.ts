import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { seedDb } from './helpers';

/**
 * Instructor assistance queue (Piece 1). Fabricates an open assistance event via
 * a tiny SQL helper script, then drives the real staff UI: login → queue → detail
 * → acknowledge → resolve (with required note). Staff auth uses the real
 * /api/login through the Next proxy (same session the student pages use).
 */
const repoRoot = resolve(__dirname, '..', '..');
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

/** Insert one open assistance event with 3 real failed assignments; print its id. */
function fabricateEvent(studentId: number): number {
  const out = execSync(`node e2e/fixtures/make-assistance-event.mjs ${studentId}`, {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  const id = Number(out.trim().split(/\s+/).pop());
  if (!Number.isInteger(id)) throw new Error(`fixture did not return an id: ${out}`);
  return id;
}

async function staffLogin(page: import('@playwright/test').Page, username: string) {
  const res = await page.request.post('/api/login', { data: { username, password: PW } });
  if (!res.ok()) throw new Error(`staff login ${username} failed: ${res.status()}`);
}

test.beforeAll(() => {
  seedDb();
  fabricateEvent(3); // Rohan Verma, CS Foundation
});

test('instructor works an assistance event end to end', async ({ page }) => {
  await staffLogin(page, 'instructor');

  // Queue lists the open event.
  await page.goto('/staff/assistance');
  await expect(page.getByRole('heading', { name: 'Assistance queue' })).toBeVisible();
  await expect(page.getByText('Rohan Verma')).toBeVisible();

  // Open the detail (enough context for a quick intervention).
  await page.locator('a[href^="/staff/assistance/"]').first().click();
  await page.waitForURL(/\/staff\/assistance\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Where they went wrong' })).toBeVisible();
  await expect(page.getByText('Correct').first()).toBeVisible();
  await expect(page.getByText('Their answer').first()).toBeVisible();

  // Acknowledge.
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Acknowledged').first()).toBeVisible();

  // Resolve requires a note: empty submit is blocked client-side.
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Describe what you did before resolving.')).toBeVisible();

  // With a note it resolves.
  await page.getByLabel(/Resolution note/).fill('Called the student and re-explained the topic.');
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Resolved').first()).toBeVisible();
  await expect(page.getByText('Called the student and re-explained the topic.')).toBeVisible();

  // It has left the open queue.
  await page.goto('/staff/assistance');
  await expect(page.getByText('Nothing needs attention')).toBeVisible();
});

test('the empty queue reads as nothing-to-do, not broken', async ({ page }) => {
  seedDb(); // no events
  await staffLogin(page, 'admin');
  await page.goto('/staff/assistance');
  await expect(page.getByText('Nothing needs attention')).toBeVisible();
});

test('a non-instructor staff member is refused the queue', async ({ page }) => {
  await staffLogin(page, 'sme');
  await page.goto('/staff/assistance');
  await expect(page.getByText('Not available for your role')).toBeVisible();
});
