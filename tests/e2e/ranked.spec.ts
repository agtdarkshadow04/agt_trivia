import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Ranked mode (#66): a member plays a run against the clock with no feedback,
 * sees only the totals, resumes a run after leaving it, and lets a question
 * time out. The Admin turns Ranked mode on through the settings API for the
 * test and off again at the end.
 */

const password = 'Member-Password-1!';
let admin: APIRequestContext;

async function settings(values: Record<string, unknown>) {
  const response = await admin.put('/api/admin/settings', { headers: { 'x-agt-request': '1' }, data: { values } });
  expect(response.status(), await response.text()).toBe(200);
}

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  const response = await admin.post('/api/admin/members', {
    headers: { 'x-agt-request': '1' },
    data: { username: 'e2e.ranked', displayName: 'Traveller Ranked', role: 'Player', password },
  });
  if (response.status() === 400) expect((await response.json()).fields[0].code).toBe('duplicate');
  else expect(response.status(), await response.text()).toBe(201);
  await settings({ 'ranked.enabled': true, 'ranked.questionsPerRun': 3, 'ranked.secondsPerQuestion': 30, 'ranked.cooldownDays': 0 });
});

test.afterAll(async () => {
  await settings({ 'ranked.enabled': null, 'ranked.questionsPerRun': null, 'ranked.secondsPerQuestion': null, 'ranked.cooldownDays': null });
  await admin.dispose();
});

async function signIn(page: Page) {
  await page.goto('/?page=login');
  await page.getByLabel('Username').fill('e2e.ranked');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
}

/** Answers the question shown with its first answer, by keyboard. */
async function answerFirst(page: Page) {
  await expect(page.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
  await page.keyboard.press('a');
  await expect(page.locator('.answer input').first()).toBeChecked();
  await page.keyboard.press('Enter');
}

test('a member plays a ranked run with no feedback and sees only the totals', async ({ page }) => {
  const watched = await watchPage(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Ranked' }).click();
  await expect(page).toHaveURL(/\?page=ranked$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ranked run' })).toBeFocused();
  await expect(page.getByText('Answer 3 questions from across the categories, 30 seconds each.')).toBeVisible();
  await expect(page.getByText('No rating yet: finish a run to get one.')).toBeVisible();
  await expectAccessible(page, 'ranked intro');

  await page.getByRole('button', { name: 'Start ranked run' }).click();
  for (let number = 1; number <= 3; number += 1) {
    await expect(page.getByText(`Question ${number} of 3`)).toBeVisible();
    await expect(page.locator('.ranked-timer')).toContainText(/\d+ s left/);
    if (number === 1) await expectAccessible(page, 'ranked question');
    await answerFirst(page);
    // Never whether the answer was right.
    await expect(page.getByText(/Correct!|Not quite|The correct answer/)).toHaveCount(0);
  }

  await expect(page.getByRole('heading', { level: 1, name: 'Your totals' })).toBeFocused();
  await expect(page.getByText('Run complete')).toBeVisible();
  const totals = page.locator('.ranked-totals');
  await expect(totals).toContainText(/Correct\s*\d of 3/);
  await expect(totals).toContainText('Your first rating');
  await expect(page.locator('.answer')).toHaveCount(0);
  await expectAccessible(page, 'ranked totals');
  for (const width of [300, 520, 760, 1180]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoHorizontalScroll(page, `ranked totals at ${width}px`);
  }
  expect(watched.consoleErrors).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('leaving a run asks first, and the member can continue it', async ({ page }) => {
  await signIn(page);
  await page.goto('/?page=ranked');
  await page.getByRole('button', { name: /Start ranked run|Start a new run/ }).click();
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  await answerFirst(page);
  await expect(page.getByText('Question 2 of 3')).toBeVisible();

  const leave = page.getByRole('alertdialog', { name: 'Leave this ranked run?' });
  await page.locator('a.brand').click();
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Keep playing' }).click();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  await page.locator('a.brand').click();
  await leave.getByRole('button', { name: 'Leave quiz' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();

  await page.getByRole('link', { name: 'Ranked' }).click();
  await expect(page.getByText('You have a run in progress.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue your run' }).click();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  for (let number = 2; number <= 3; number += 1) {
    await expect(page.getByText(`Question ${number} of 3`)).toBeVisible();
    await answerFirst(page);
  }
  await expect(page.getByRole('heading', { name: 'Your totals' })).toBeVisible();
});

test('a question the member does not answer in time scores nothing, and the run moves on', async ({ page }) => {
  test.setTimeout(60_000);
  await settings({ 'ranked.secondsPerQuestion': 5 });
  try {
    await signIn(page);
    await page.goto('/?page=ranked');
    await page.getByRole('button', { name: /Start ranked run|Start a new run/ }).click();
    await expect(page.getByText('Question 1 of 3')).toBeVisible();
    await expect(page.getByText('Question 2 of 3')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('status').filter({ hasText: "Time's up: that question scores nothing." })).toBeAttached();
  } finally {
    await settings({ 'ranked.secondsPerQuestion': 30 });
  }
});

test('Ranked mode is only for members, and only while it is on', async ({ page }) => {
  await page.goto('/?page=ranked');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await settings({ 'ranked.enabled': false });
  try {
    await signIn(page);
    await expect(page.getByRole('link', { name: 'Ranked' })).toHaveCount(0);
    await page.goto('/?page=ranked');
    await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  } finally {
    await settings({ 'ranked.enabled': true });
  }
});
