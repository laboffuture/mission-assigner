import { test, expect } from '@playwright/test';
import { seedDb, loginAs } from './helpers';

test.beforeAll(() => seedDb());

test('new student progress reads as a starting point, not a broken screen', async ({ page }) => {
  await loginAs(page, 3); // freshly seeded, no submissions

  await page.goto('/progress');

  // Placement is shown at the segment start, not blank.
  await expect(page.getByText(/Level 0 in CS Foundation/)).toBeVisible();
  // Streak framed as a starting point.
  await expect(page.getByText('Start your streak')).toBeVisible();
  // Empty log has a friendly message, not an empty void.
  await expect(page.getByText('No missions completed yet')).toBeVisible();
});
