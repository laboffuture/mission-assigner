import { test, expect } from '@playwright/test';
import { seedDb, loginAs, setFeedbackGating } from './helpers';

test.beforeAll(() => seedDb());

test('week → mission → result → feedback → progress', async ({ page }) => {
  await loginAs(page, 1);
  await setFeedbackGating(page, true); // deterministic: result routes to feedback

  // Week board — the primary screen.
  await page.goto('/week');
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  await expect(page.getByText('Weekly mission', { exact: true })).toBeVisible();

  // Open the first available mission.
  await page.locator('a[href^="/mission/"]').first().click();
  await expect(page).toHaveURL(/\/mission\//);

  // Answer it.
  await expect(page.locator('input[type=radio]').first()).toBeVisible();
  await page.locator('input[type=radio]').first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();

  // Result — the explanation (the teaching moment) is shown.
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();

  // Next action — feedback (gating is on by default).
  await page.getByRole('button', { name: /Give feedback to continue/ }).click();
  await expect(page).toHaveURL(/\/feedback\//);

  // Feedback — answer every required question (first choice in each block).
  await expect(page.getByRole('heading', { name: 'Quick feedback' })).toBeVisible();
  for (const key of ['perceived_difficulty', 'time_taken', 'clarity', 'confidence']) {
    await page.getByTestId(`fq-${key}`).getByRole('button').first().click();
  }
  await page.getByRole('button', { name: 'Submit & continue' }).click();

  // Reward + onward.
  await expect(page.getByText(/\+\d+ XP|Thanks!/)).toBeVisible();
  await expect(page.getByText('Your next mission is ready')).toBeVisible();
  await page.getByRole('button', { name: /Continue to this week/ }).click();
  await expect(page).toHaveURL(/\/week$/);

  // Progress reflects the completed mission.
  await page.goto('/progress');
  await expect(page.getByText('XP total')).toBeVisible();
  await expect(page.getByText(/Passed|Not passed/).first()).toBeVisible();
});
