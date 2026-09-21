import { test, expect } from '@playwright/test';
import { seedDb, loginAs, spreadFrom, titleFor } from './helpers';

/**
 * Moved verbatim from submit-resilience.spec.ts, into its own file with its own
 * seed. Once both of that file's tests ran for the same boundary students, this
 * one inherited the mission the network-drop test had just completed (the first
 * mission link became a review page). The original spec never shared a student
 * between the two tests — student 2 there, student 1 here — and a separate file
 * restores exactly that isolation without changing either test.
 */
test.beforeAll(() => seedDb());

for (const id of spreadFrom(1)) {
  test(titleFor('an expired session on a client action redirects to /login', id, 1), async ({ page, context }) => {
    await loginAs(page, id);
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
}
