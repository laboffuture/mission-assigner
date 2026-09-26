import { test, expect } from '@playwright/test';
import { seedDb } from './helpers';

/**
 * The weekly pilot report (audit item 15). Three things matter here and nothing
 * else: every staff role can read it, a student cannot, and the thing you email
 * actually downloads as a document rather than a page of JSON.
 *
 * Staff auth goes through the real /api/login via the Next proxy, the same
 * session path the assistance queue uses.
 */
const PW = process.env.STAFF_DEFAULT_PASSWORD || 'changeme';

test.beforeAll(() => seedDb());

async function staffLogin(page: import('@playwright/test').Page, username: string) {
  const res = await page.request.post('/api/login', { data: { username, password: PW } });
  if (!res.ok()) throw new Error(`staff login ${username} failed: ${res.status()}`);
}

test('the SME reads the report and can download it to email', async ({ page }) => {
  await staffLogin(page, 'sme');
  await page.goto('/staff/pilot-report');

  await expect(page.getByRole('heading', { name: 'Pilot report', level: 1 })).toBeVisible();

  // Every question the report was asked for has its own section. If one of these
  // headings disappears, a question stopped being answered.
  for (const heading of [
    'What needs attention',
    'How much of the work gets finished',
    'Where students get stuck',
    'Missions labelled with the wrong difficulty',
    'Hours without enough material',
    'What students say about the work',
    'Whether the time bands are honest',
    'Repeats handed out because the content ran out',
    'How to read this',
  ]) {
    await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
  }

  // The document: a real file, named for its end date, and self-contained.
  const link = page.getByRole('link', { name: /Download this report to email/ });
  await expect(link).toHaveAttribute('href', '/api/pilot-report?format=html');
  const doc = await page.request.get('/api/pilot-report?format=html');
  expect(doc.status()).toBe(200);
  expect(doc.headers()['content-type']).toContain('text/html');
  expect(doc.headers()['content-disposition']).toMatch(/attachment; filename="pilot-report-\d{4}-\d{2}-\d{2}\.html"/);
  const html = await doc.text();
  expect(html).toContain('Mission Hub — pilot report');
  // Nothing external: it has to open from an email attachment with no network.
  expect(html).not.toMatch(/<(script|link|img)\b/i);
  expect(html).not.toMatch(/https?:\/\//);
});

test('an instructor reaches it from the staff tabs; a student is refused', async ({ page }) => {
  await staffLogin(page, 'instructor');
  await page.goto('/staff/assistance');
  await page.getByRole('link', { name: 'Pilot report' }).click();
  await page.waitForURL(/\/staff\/pilot-report$/);
  await expect(page.getByRole('heading', { name: 'Pilot report', level: 1 })).toBeVisible();

  // A student gets the role refusal, not the report and not a crash.
  const res = await page.request.post('/api/dev/login-as', { data: { studentId: 9 } });
  expect(res.ok()).toBe(true);
  await page.goto('/staff/pilot-report');
  await expect(page.getByRole('heading', { name: 'Not available for your role' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What needs attention' })).toHaveCount(0);
  expect((await page.request.get('/api/pilot-report')).status()).toBe(403);
});
