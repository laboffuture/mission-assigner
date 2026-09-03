import { test, expect } from '@playwright/test';
import { seedDb, loginAs } from './helpers';

test.beforeAll(() => seedDb());

test('a mid-submit network drop is retryable and reuses the Idempotency-Key', async ({ page }) => {
  await loginAs(page, 2);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await expect(page).toHaveURL(/\/mission\//);
  await expect(page.locator('input[type=radio]').first()).toBeVisible();
  await page.locator('input[type=radio]').first().check();

  // Fail the FIRST submit at the network layer; let the retry through. Capture the
  // Idempotency-Key of every attempt to prove the retry reuses it (not a new key).
  const keys: (string | undefined)[] = [];
  let firstDone = false;
  await page.route('**/api/submit', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    if (!firstDone) {
      firstDone = true;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await page.getByRole('button', { name: 'Submit answer' }).click();

  // The answer is preserved and a retry is offered (not a dead end).
  await expect(page.getByText(/your answer is safe/i)).toBeVisible();
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await retry.click();

  // The retry succeeds and the result renders.
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();

  // Two attempts, SAME key.
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]);
});

test('an expired session on a client action redirects to /login', async ({ page, context }) => {
  await loginAs(page, 1);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await expect(page.locator('input[type=radio]').first()).toBeVisible();
  await page.locator('input[type=radio]').first().check();

  // Session expires mid-screen.
  await context.clearCookies();

  // A client mutation now 401s → the client interceptor sends us to /login.
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
