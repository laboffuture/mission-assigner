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

/**
 * The theme the LMS chose travels in the SESSION, not in a cookie of its own.
 *
 * This is the WebKit fix. The old `lof_theme` cookie was SameSite=None; Secure so
 * it would survive the LMS's cross-site iframe: WebKit will not send a Secure
 * cookie to an http origin at all, so the theme silently reverted on Safari and
 * iPad, and Safari blocks third-party cookies in an iframe anyway, so it would
 * not have survived the case it was written for either. The session already has
 * to work in both places, so the theme rides in it.
 *
 * Runs on every project, which is the point: it is the engine difference that
 * started this.
 */
test('the theme comes from the session, with no theme cookie and nothing Secure', async ({ page, context }) => {
  await context.clearCookies();
  await loginAs(page, 9, { theme: 'horizon' });

  // The ONLY source of the theme here: no ?theme= in any URL below, and no
  // lof_theme cookie in the jar.
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).not.toContain('lof_theme');

  await page.goto('/week');
  await expect(page.locator('html')).toHaveAttribute('data-lof-theme', 'horizon');
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(250, 250, 250)');

  // ...and it survives navigation inside the tool, which is what actually broke.
  await page.goto('/progress');
  await expect(page.locator('html')).toHaveAttribute('data-lof-theme', 'horizon');
  expect((await context.cookies()).map((c) => c.name)).not.toContain('lof_theme');

  // Nothing the app needs is Secure over http, which is exactly what WebKit
  // refused to send back. If this starts failing, the theme is on a cookie again.
  const secure = (await context.cookies()).filter((c) => c.secure).map((c) => c.name);
  expect(secure, `Secure cookies on an http origin: ${secure.join(', ')}`).toEqual([]);

  // A session without a theme falls back to the LMS default rather than the last
  // learner's theme.
  await context.clearCookies();
  await loginAs(page, 9);
  await page.goto('/week');
  await expect(page.locator('html')).toHaveAttribute('data-lof-theme', 'nebula');
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
