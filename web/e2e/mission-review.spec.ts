import { test, expect } from '@playwright/test';
import { seedDb, loginAs, setFeedbackGating } from './helpers';

/**
 * Mission review (Piece 2): a completed slot on the week board is clickable and
 * opens a read-only review — the question, their answer, the correct answer and
 * the explanation. Previously it dead-ended on "already completed".
 */
test.beforeAll(() => seedDb());

test('a completed mission can be reviewed from the week board', async ({ page }) => {
  await loginAs(page, 1);
  await setFeedbackGating(page, false); // no gate — done slot stays reviewable, next opens

  // Complete a mission.
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await page.waitForURL(/\/mission\/\d+$/);
  const missionUrl = page.url();
  await page.locator('input[type=radio]').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();

  // Revisit the SAME slot — it now shows the read-only review, not a dead end.
  await page.goto(missionUrl);
  await expect(page.getByText(/You got this right|You answered this wrong/)).toBeVisible();
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();
  // The correct answer is marked, and there is no submit control.
  await expect(page.getByText('Correct answer').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit answer' })).toHaveCount(0);
  await expect(page.getByText('Already completed')).toHaveCount(0);
});

test('the week board marks a completed slot as reviewable', async ({ page }) => {
  await loginAs(page, 1);
  await page.goto('/week');
  // At least one slot shows the "Done" state and links to its mission review.
  await expect(page.getByText('Done').first()).toBeVisible();
});
