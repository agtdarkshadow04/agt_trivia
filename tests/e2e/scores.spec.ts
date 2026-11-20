import { expect, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectNoHorizontalScroll, preferences, watchPage } from './fixtures';

/**
 * Member score history (#21): a signed-in member's finished quiz is saved to
 * their history, graded by the server; My scores shows it, in the reader's
 * time zone, and clears it. Anonymous players are invited to sign in.
 */

const password = 'Member-Password-1!';

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  for (const username of ['e2e.scorer', 'e2e.other']) {
    const response = await admin.post('/api/admin/members', {
      headers: { 'x-agt-request': '1' },
      data: { username, displayName: `Traveller ${username}`, role: 'Player', password },
    });
    // A retry runs beforeAll again: an existing member is fine.
    if (response.status() === 400) expect((await response.json()).fields[0].code).toBe('duplicate');
    else expect(response.status(), await response.text()).toBe(201);
  }
  await admin.dispose();
});

async function signIn(page: Page, username: string) {
  await page.goto('/?page=login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
}

/** Plays the 3 Biology questions, answering `right` of them right (the multi-answer one first among them). */
async function playBiology(page: Page, right: number) {
  await page.goto('/?category=bio');
  await page.getByRole('button', { name: /Full quiz/ }).click();
  let answeredRight = 0;
  for (let number = 1; number <= 3; number += 1) {
    await expect(page.getByText(`Question ${number} of 3`)).toBeVisible();
    const multi = await page.getByText('Select every correct answer').isVisible();
    const role = multi ? 'checkbox' : 'radio';
    const correct = answeredRight < right;
    if (correct) {
      for (const option of await page.getByRole(role, { name: /^[A-D]?\s*(Also right|Right)/ }).all()) await option.check();
      answeredRight += 1;
    } else {
      await page.getByRole(role, { name: /^[A-D]?\s*Wrong/ }).first().check();
    }
    await page.getByRole('button', { name: 'Lock answer' }).click();
    await page.getByRole('button', { name: number === 3 ? 'View results' : 'Next question' }).click();
  }
}

test('a member\'s finished quiz is saved to their history, shown in My scores and cleared', async ({ page }) => {
  const watched = await watchPage(page);
  await preferences(page, { timeZone: '+05:30' });
  await signIn(page, 'e2e.scorer');
  await page.getByRole('link', { name: 'My scores' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My scores' })).toBeFocused();
  await expect(page.getByText('You have no saved scores yet.')).toBeVisible();

  await playBiology(page, 3);
  await expect(page.getByRole('heading', { name: 'Atlas Archivist' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your history.' })).toBeVisible();
  await expectAccessible(page, 'saved results');
  await playBiology(page, 1);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your history.' })).toBeVisible();

  await page.getByRole('link', { name: 'My scores' }).click();
  const stats = page.getByRole('article').filter({ hasText: 'Biology' });
  await expect(stats).toContainText('Plays');
  await expect(stats.getByRole('definition').nth(0)).toHaveText('2');
  await expect(stats.getByRole('definition').nth(1)).toHaveText('100%');
  await expect(stats.getByRole('definition').nth(2)).toHaveText('67%');
  const entries = page.locator('.score-entry');
  await expect(entries).toHaveCount(2);
  // Newest first, graded by the server, the time in the reader's time zone (I18N-5).
  await expect(entries.nth(0)).toContainText('1 of 3 correct · 33%');
  await expect(entries.nth(1)).toContainText('3 of 3 correct · 100%');
  await expect(entries.nth(0)).toContainText('Full quiz');
  await expect(entries.nth(0).locator('time')).toContainText('GMT+5:30');
  await page.getByLabel('Category').selectOption({ label: 'Biology' });
  await expect(entries).toHaveCount(2);
  await expectAccessible(page, 'my scores');

  // Nobody else sees them.
  const other = await page.context().browser()!.newPage();
  await signIn(other, 'e2e.other');
  await other.goto('/?page=scores');
  await expect(other.getByText('You have no saved scores yet.')).toBeVisible();
  await other.close();

  await page.getByRole('button', { name: 'Clear history' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your score history was cleared.' })).toBeVisible();
  await expect(page.getByText('You have no saved scores yet.')).toBeVisible();
  expect(watched.consoleErrors.filter((message) => !/status of 401/.test(message))).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('a failed save offers a retry, and anonymous players are invited to sign in', async ({ page }) => {
  await playBiology(page, 2);
  await expect(page.getByText('Sign in to keep your scores in your own history.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\?page=login$/);

  await signIn(page, 'e2e.other');
  let failed = false;
  // The server cannot fail on demand; this simulates one failed save whose answer was lost after the server had
  // saved it (#45): the retry sends the same signed attempt, so the history still holds the quiz once.
  await page.route('**/api/member/results', async (route) => {
    if (failed || route.request().method() !== 'POST') return route.continue();
    failed = true;
    expect((await route.fetch()).status()).toBe(201);
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Boom.' }) });
  });
  await playBiology(page, 2);
  await expect(page.getByRole('alert')).toContainText('Your score could not be saved: Something went wrong on the server. Try again later.');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your history.' })).toBeVisible();
  await page.goto('/?page=scores');
  await expect(page.locator('.score-entry')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear history' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('You have no saved scores yet.')).toBeVisible();
});

test('My scores is for members only, and fits every width and 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
  await page.goto('/?page=scores');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await signIn(page, 'e2e.scorer');
  await playBiology(page, 2);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your history.' })).toBeVisible();
  for (const [scale, widths] of [['1', [300, 520, 760, 1180]], ['2', [300]]] as const) {
    await page.addInitScript((fontScale) => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale })), scale);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?page=scores');
      await expect(page.locator('.score-entry').first()).toBeVisible();
      await expectNoHorizontalScroll(page, `my scores at ${width}px, ${scale}×`);
    }
  }
  await page.getByRole('button', { name: 'Clear history' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('You have no saved scores yet.')).toBeVisible();
});
