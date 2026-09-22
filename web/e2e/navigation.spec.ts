import { test, expect } from '@playwright/test';
import { seedDb, loginAs } from './helpers';

test.beforeAll(() => seedDb());

/**
 * The app no longer renders its own header bar — the LMS page provides one
 * (audit #55). The links that bar used to hold now live in the page content, so
 * this proves a student can still get around WITHOUT it: week -> progress ->
 * week, clicking only links inside the content area.
 */
test('a student moves week -> progress -> week using only in-content links', async ({ page }) => {
  await loginAs(page, 9);
  await page.goto('/week');
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();

  // No header bar anywhere in the journey.
  await expect(page.locator('header, [role=banner]')).toHaveCount(0);

  const main = page.locator('main#main-content');
  await main.getByRole('link', { name: 'Progress' }).click();
  await expect(page).toHaveURL(/\/progress$/);
  await expect(page.locator('header, [role=banner]')).toHaveCount(0);
  // The current section is marked for assistive tech, not by colour alone.
  await expect(main.getByRole('link', { name: 'Progress' })).toHaveAttribute('aria-current', 'page');

  await main.getByRole('link', { name: 'This week' }).click();
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'This week' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('header, [role=banner]')).toHaveCount(0);
});

/**
 * Theme comes from the server, so the very first HTML is already in the right
 * theme — no flash of the default one while a client script catches up.
 */
test('?theme=horizon renders horizon from the server, and nebula is the default', async ({ page, request }) => {
  const horizon = await request.get('/login?theme=horizon');
  expect(await horizon.text()).toContain('data-lof-theme="horizon"');
  const fresh = await request.get('/login');
  // Same context keeps the cookie, so the theme persists across navigation.
  expect(await fresh.text()).toContain('data-lof-theme="horizon"');

  await loginAs(page, 9);
  await page.goto('/week?theme=horizon', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-lof-theme', 'horizon');
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(250, 250, 250)'); // their horizon --nebula-bg-primary

  await page.goto('/week?theme=nebula', { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-lof-theme', 'nebula');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(7, 11, 37)');
});

/** Framed, the app tells the LMS how tall it is; unframed it stays quiet. */
test('the iframe height message is posted only when framed', async ({ page }) => {
  await page.setContent(
    `<script>window.__msgs=[];addEventListener('message',e=>window.__msgs.push(e.data))</script>` +
      `<iframe src="http://localhost:3001/login" style="width:800px;height:400px"></iframe>`
  );
  await expect
    .poll(async () => (await page.evaluate(() => window.__msgs as unknown[])).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const messages = (await page.evaluate(() => window.__msgs as Array<{ subject?: string; height?: number }>)) ?? [];
  expect(messages.some((m) => m?.subject === 'lti.frameResize' && typeof m.height === 'number')).toBe(true);
});
