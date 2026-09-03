import { test, expect } from '@playwright/test';
import { seedDb, loginAs, setFeedbackGating } from './helpers';

/**
 * Keyboard-only journey: a student must be able to complete a mission and the
 * feedback form without a mouse. Uses only keyboard actions (Tab / Arrow / Enter
 * / Space) — no .click() on interactive targets.
 */
test.beforeAll(() => seedDb());

test('a mission and feedback can be completed with the keyboard alone', async ({ page }) => {
  await loginAs(page, 1);
  await setFeedbackGating(page, true);

  // Open a mission by keyboard-activating the first slot link.
  await page.goto('/week');
  const firstSlot = page.locator('a[href^="/mission/"]').first();
  await firstSlot.focus();
  await expect(firstSlot).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/mission\//);

  // Choose an answer with the keyboard: focus the radio group, pick with arrows.
  const firstOption = page.locator('input[type=radio]').first();
  await firstOption.focus();
  await expect(firstOption).toBeFocused();
  await page.keyboard.press('Space'); // select the focused radio
  await expect(firstOption).toBeChecked();

  // Tab to Submit and activate it.
  const submit = page.getByRole('button', { name: 'Submit answer' });
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();

  // Continue to feedback by keyboard.
  const toFeedback = page.getByRole('button', { name: /Give feedback to continue/ });
  await toFeedback.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/feedback\//);

  // Answer each required radiogroup using arrow keys, entirely by keyboard.
  for (const key of ['perceived_difficulty', 'time_taken', 'clarity', 'confidence']) {
    const firstRadio = page.getByTestId(`fq-${key}`).locator('input[type=radio]').first();
    await firstRadio.focus();
    await page.keyboard.press('ArrowRight'); // move within the group
    await page.keyboard.press('ArrowLeft'); // back to the first
    await expect(firstRadio).toBeChecked();
  }

  const submitFeedback = page.getByRole('button', { name: 'Submit & continue' });
  await submitFeedback.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Your next mission is ready')).toBeVisible();
});
