import { test, expect } from '@playwright/test';
import { seedDb, loginAs, spreadFrom, titleFor } from './helpers';

test.beforeAll(() => seedDb());

for (const id of spreadFrom(3)) {
  test(titleFor('new student progress reads as a starting point, not a broken screen', id, 3), async ({ page }) => {
    await loginAs(page, id); // freshly seeded, no submissions

    await page.goto('/progress');

    // Placement is shown at the segment start, not blank.
    await expect(
      page.getByText(id === 3 ? /Level 0 in CS Foundation/ : /Level \d+ in CS (Foundation|Intermediate|Advanced)/)
    ).toBeVisible();
    // Streak framed as a starting point.
    await expect(page.getByText('Start your streak')).toBeVisible();
    // Empty log has a friendly message, not an empty void.
    await expect(page.getByText('No missions completed yet')).toBeVisible();
  });
}
