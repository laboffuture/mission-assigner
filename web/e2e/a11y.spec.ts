import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seedDb, loginAs, setFeedbackGating } from './helpers';

/**
 * Automated accessibility checks with axe-core across the student surface,
 * including colour-contrast (WCAG 2.1 AA). Contrast is evaluated against the
 * CURRENT placeholder token values in styles/tokens.css — when the real LMS
 * palette lands, re-run this: a failing token pair tells us to adjust our usage
 * or raise it with them.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: import('@playwright/test').Page) {
  return (
    new AxeBuilder({ page })
      .withTags(TAGS)
      // Exclude the Next.js dev-mode error/build overlay — it is dev-only chrome
      // (absent from production builds), not part of our UI.
      .exclude('nextjs-portal')
      .analyze()
  );
}

test.beforeAll(() => seedDb());

test('week board has no accessibility violations', async ({ page }) => {
  await loginAs(page, 1);
  await page.goto('/week');
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('mission (answering) has no accessibility violations', async ({ page }) => {
  await loginAs(page, 1);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await expect(page.locator('input[type=radio]').first()).toBeAttached();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('mission result has no accessibility violations', async ({ page }) => {
  await loginAs(page, 1);
  await setFeedbackGating(page, true);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await page.locator('input[type=radio]').first().check({ force: true });
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('feedback form has no accessibility violations', async ({ page }) => {
  // Reach a real feedback screen by grading a mission first.
  await loginAs(page, 2);
  await setFeedbackGating(page, true);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await page.locator('input[type=radio]').first().check({ force: true });
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await page.getByRole('button', { name: /Give feedback to continue/ }).click();
  await expect(page.getByRole('heading', { name: 'Quick feedback' })).toBeVisible();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('progress panel has no accessibility violations', async ({ page }) => {
  await loginAs(page, 1);
  await page.goto('/progress');
  await expect(page.getByText('XP total')).toBeVisible();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('login (dev launch) has no accessibility violations', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Mission Hub' })).toBeVisible();
  const results = await scan(page);
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
