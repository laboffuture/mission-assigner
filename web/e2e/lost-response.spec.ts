import { test, expect } from '@playwright/test';
import { seedDb, loginAs } from './helpers';

test.beforeAll(() => seedDb());

/**
 * The first submit is graded by the server, but its response never reaches the
 * student. Seeing an error, they change their answer and submit again — a new
 * answer, so the client uses a NEW Idempotency-Key.
 *
 * They must get their ORIGINAL graded result, shown as already submitted: not
 * an error ("this assignment is not open"), not a 422, and not a second grade.
 */
test('a submit whose response was lost shows the original result, marked already submitted', async ({ page }) => {
  await loginAs(page, 8);
  await page.goto('/week');
  await page.locator('a[href^="/mission/"]').first().click();
  await expect(page).toHaveURL(/\/mission\//);

  const radios = page.locator('input[type=radio]');
  await expect(radios.first()).toBeVisible();
  // Each option's own text, so the result recap can be matched without relying
  // on the ✓/✗ prefix it adds in front of the option key.
  const optionTexts = await page
    .locator('label')
    .filter({ has: radios })
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));

  // Attempt 1: let the request reach the server (it grades), then drop the
  // response — exactly what a dropped connection looks like to the browser.
  const statuses: number[] = [];
  const keys: (string | undefined)[] = [];
  let first = true;
  await page.route('**/api/submit', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    if (first) {
      first = false;
      await route.fetch(); // the server grades this one
      await route.abort('failed'); // ...and the student never sees it
      return;
    }
    const response = await route.fetch();
    statuses.push(response.status());
    await route.fulfill({ response });
  });

  await radios.first().check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByText(/your answer is safe/i)).toBeVisible();

  // Attempt 2: a DIFFERENT answer, so the client sends a new key.
  await radios.nth(1).check();
  await page.getByRole('button', { name: /Submit answer|Try again/ }).click();

  // The result renders, and says plainly that it was already submitted.
  await expect(page.getByText(/already submitted this mission/i)).toBeVisible();
  await expect(page.getByText(/Why this is the answer|Here’s why/)).toBeVisible();
  await expect(page.getByText(/your answer is safe/i)).toHaveCount(0);
  await expect(page.getByText(/not open|Idempotency-Key/i)).toHaveCount(0);

  // 200, not 422 or 400.
  expect(statuses).toEqual([200]);
  // Two different keys: the answer changed between the attempts.
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBeTruthy();
  expect(keys[0]).not.toBe(keys[1]);

  // The result shown is the FIRST answer's, not the second's: the first option is
  // marked (as the correct answer, or as the answer they gave), and the option
  // picked in the second attempt is never labelled as theirs.
  const itemFor = (text: string) => page.getByRole('listitem').filter({ hasText: text });
  await expect(itemFor(optionTexts[0]).getByText(/Correct answer|Your answer/)).toHaveCount(1);
  await expect(itemFor(optionTexts[1]).getByText(/Your answer/)).toHaveCount(0);
});
