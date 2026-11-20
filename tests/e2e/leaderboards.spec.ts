import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Opt-in leaderboards (#49): closed by default; the Admin turns them on in
 * Settings; a member opts in from the account menu, plays a full quiz and
 * appears on the category's board by display name, while a member who did
 * not opt in does not; opting out takes them off. Runs serially and turns
 * leaderboards off again at the end: it switches a setting other tests share.
 */

test.describe.configure({ mode: 'serial' });

const password = 'Member-Password-1!';

async function createMember(request: APIRequestContext, username: string) {
  const response = await request.post('/api/admin/members', {
    headers: { 'x-agt-request': '1' },
    data: { username, displayName: `Traveller ${username}`, role: 'Player', password },
  });
  // A retry runs this again: an existing member is fine.
  if (response.status() === 400) expect((await response.json()).fields[0].code).toBe('duplicate');
  else expect(response.status(), await response.text()).toBe(201);
}

async function setLeaderboards(page: Page, enabled: boolean) {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Settings' }).click();
  const box = page.getByLabel('Show a public leaderboard for each category');
  if ((await box.isChecked()) !== enabled) {
    await box.setChecked(enabled);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
  }
}

async function signIn(page: Page, username: string) {
  await page.goto('/?page=login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
}

/** Plays Space's short (10 questions) or full (12) quiz, every answer right, until the result is saved. */
async function playSpace(page: Page, length: 'Short' | 'Full') {
  const total = length === 'Short' ? 10 : 12;
  await page.goto('/?category=space');
  await page.getByRole('button', { name: new RegExp(`${length} quiz`) }).click();
  for (let number = 1; number <= total; number += 1) {
    await expect(page.getByText(`Question ${number} of ${total}`)).toBeVisible();
    const multi = await page.getByText('Select every correct answer').isVisible();
    for (const option of await page.getByRole(multi ? 'checkbox' : 'radio', { name: /^[A-D]?\s*(Also right|Right)/ }).all()) await option.check();
    await page.getByRole('button', { name: 'Lock answer' }).click();
    await page.getByRole('button', { name: number === total ? 'View results' : 'Next question' }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Saved to your history.' })).toBeVisible();
}

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  await createMember(admin, 'e2e.ranker');
  await createMember(admin, 'e2e.private');
  await admin.dispose();
});

test('leaderboards are closed until the Admin turns them on', async ({ page }) => {
  await page.goto('/?category=space');
  await expect(page.getByRole('heading', { name: 'Choose quiz length' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leaderboard' })).toHaveCount(0);
  // A link to a board says it is closed instead of hiding.
  await page.goto('/?category=space&view=leaderboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByText('Leaderboards are turned off on this site.')).toBeVisible();
});

test.describe('with leaderboards on', () => {
  test.beforeAll(async ({ browser }) => {
    const admin = await browser.newPage({ storageState: adminState });
    await setLeaderboards(admin, true);
    await admin.close();
  });
  test.afterAll(async ({ browser }) => {
    const admin = await browser.newPage({ storageState: adminState });
    await setLeaderboards(admin, false);
    await admin.close();
  });

  test('a member who opts in appears by display name after a short quiz; one who did not, never', async ({ browser }) => {
    const ranker = await (await browser.newContext()).newPage();
    const watched = await watchPage(ranker);
    await signIn(ranker, 'e2e.ranker');
    // The account menu: off by default, then on.
    await ranker.getByRole('button', { name: 'Account' }).click();
    const account = ranker.getByRole('dialog', { name: 'Account' });
    const optIn = account.getByLabel('Show me on leaderboards');
    await expect(optIn).toBeEnabled();
    await expect(optIn).not.toBeChecked();
    await expectAccessible(ranker, 'account with the leaderboard opt-in');
    await optIn.check();
    await expect(account.getByRole('status').filter({ hasText: 'You now appear on the leaderboards.' })).toBeVisible();
    await expect(optIn).toBeChecked();
    await account.getByRole('button', { name: 'Close' }).click();
    // #60: the Short quiz, the first length offered, counts like any quiz of at least quiz.shortLength questions.
    await playSpace(ranker, 'Short');

    const other = await (await browser.newContext()).newPage();
    await signIn(other, 'e2e.private');
    await playSpace(other, 'Full');

    // The board, from the category's length choice.
    await ranker.goto('/?category=space');
    await ranker.getByRole('button', { name: 'Leaderboard' }).click();
    await expect(ranker).toHaveURL(/\?category=space&view=leaderboard$/);
    await expect(ranker.getByRole('heading', { level: 1, name: 'Leaderboard' })).toBeFocused();
    const row = ranker.getByRole('row').filter({ has: ranker.getByRole('rowheader', { name: 'Traveller e2e.ranker' }) });
    await expect(row).toContainText('1');
    await expect(row).toContainText('100%');
    await expect(ranker.getByRole('rowheader', { name: 'Traveller e2e.private' })).toHaveCount(0);
    await expect(ranker.getByText('at least 10 questions')).toBeVisible();
    // #60: the opt-in hint is only for members who have not opted in.
    await expect(ranker.getByText('To appear here, turn on')).toHaveCount(0);
    await other.goto('/?category=space&view=leaderboard');
    await expect(other.getByText('To appear here, turn on “Show me on leaderboards” in your account.')).toBeVisible();
    await expectAccessible(ranker, 'leaderboard');
    // Play this category goes back to the length choice.
    await ranker.getByRole('button', { name: 'Play this category' }).click();
    await expect(ranker.getByRole('heading', { name: 'Choose quiz length' })).toBeVisible();

    // Visitors see the same board.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto('/?category=space&view=leaderboard');
    await expect(visitor.getByRole('rowheader', { name: 'Traveller e2e.ranker' })).toBeVisible();

    // Opting out takes the member off at once.
    await ranker.getByRole('button', { name: 'Account' }).click();
    const stored = ranker.getByRole('dialog', { name: 'Account' }).getByLabel('Show me on leaderboards');
    // The box shows the stored choice once it has loaded.
    await expect(stored).toBeEnabled();
    await expect(stored).toBeChecked();
    await stored.uncheck();
    await expect(ranker.getByRole('status').filter({ hasText: 'You no longer appear on the leaderboards.' })).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByText('Nobody is on this leaderboard yet.')).toBeVisible();

    expect(watched.consoleErrors).toEqual([]);
    expect(await watched.violations()).toEqual([]);
    for (const page of [ranker, other, visitor]) await page.context().close();
  });

  test('the leaderboard fits every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, 'e2e.ranker');
    await page.getByRole('button', { name: 'Account' }).click();
    const optIn = page.getByRole('dialog', { name: 'Account' }).getByLabel('Show me on leaderboards');
    await expect(optIn).toBeEnabled();
    await optIn.check();
    await expect(page.getByText('You now appear on the leaderboards.')).toBeVisible();
    for (const [scale, widths] of [['1', [300, 520, 760, 1180]], ['2', [300]]] as const) {
      await page.addInitScript((fontScale) => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale })), scale);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/?category=space&view=leaderboard');
        await expect(page.getByRole('rowheader', { name: 'Traveller e2e.ranker' })).toBeVisible();
        await expectNoHorizontalScroll(page, `leaderboard at ${width}px, ${scale}×`);
      }
    }
    // Leave the member off the boards again.
    await page.goto('/');
    await page.getByRole('button', { name: 'Account' }).click();
    const leave = page.getByRole('dialog', { name: 'Account' }).getByLabel('Show me on leaderboards');
    await expect(leave).toBeChecked();
    await leave.uncheck();
    await expect(page.getByText('You no longer appear on the leaderboards.')).toBeVisible();
    await page.context().close();
  });
});
