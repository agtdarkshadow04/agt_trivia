import { expect, type APIRequestContext, test } from '@playwright/test';
import { adminState, expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Member accounts (#17): the Admin manages them in the Members tab, and
 * members sign in on the player page as Player, Editor or Moderator.
 */

const password = 'Member-Password-1!';

/** Creates a member through the API with the saved Admin session; returns its ID. */
async function createMember(request: APIRequestContext, username: string, role: string) {
  const response = await request.post('/api/admin/members', {
    headers: { 'x-agt-request': '1' },
    data: { username, displayName: `Traveller ${username}`, role, password },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).member.id as string;
}

test.describe('the Admin', () => {
  test.use({ storageState: adminState });

  test('creates, edits, resets and deletes a member in the Members tab', async ({ page }) => {
    const watched = await watchPage(page);
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Members' }).click();
    await expect(page.getByRole('heading', { name: 'Create a member' })).toBeVisible();

    // FE-6: the browser checks with the server's rules first.
    await page.getByLabel('Username').fill('bad name');
    await page.getByRole('button', { name: 'Create member' }).click();
    await expect(page.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');

    await page.getByLabel('Username').fill('E2E.Manage');
    await page.getByLabel('Display name').fill('Editor in Chief');
    await page.getByLabel('Role').selectOption('Editor');
    await page.getByLabel('Initial password').fill(password);
    await page.getByRole('button', { name: 'Create member' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'e2e.manage' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'e2e.manage' });
    await expect(row).toContainText('Editor in Chief');
    await expect(row).toContainText('Editor');
    await expect(row).toContainText('Active');
    await expectAccessible(page, 'members tab');

    // #48: the last sign-in, "Never" until the member signs in, and the filter of idle members.
    await expect(row).toContainText('Never');
    const memberPage = await page.context().browser()!.newPage();
    await memberPage.goto('/?page=login');
    await memberPage.getByLabel('Username').fill('e2e.manage');
    await memberPage.getByLabel('Password').fill(password);
    await memberPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(memberPage.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
    await memberPage.close();
    const idle = page.getByLabel('Signed in');
    await idle.selectOption({ label: 'Not in the last 30 days' });
    await expect(row).toHaveCount(0);
    await idle.selectOption({ label: 'At any time' });
    await expect(row).not.toContainText('Never');
    await expect(row.locator('time')).toHaveCount(1);

    // A duplicate username is the server's to refuse, translated.
    await page.getByLabel('Username').fill('e2e.manage');
    await page.getByLabel('Display name').fill('Another');
    await page.getByLabel('Initial password').fill(password);
    await page.getByRole('button', { name: 'Create member' }).click();
    await expect(page.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');

    // Edit: promote and rename, then set a new password.
    const edit = row.getByRole('button', { name: 'Edit e2e.manage' });
    await expectDialogBehaviour(page, edit, 'Edit e2e.manage');
    await edit.click();
    const dialog = page.getByRole('dialog', { name: 'Edit e2e.manage' });
    await expectAccessible(page, 'member editor');
    await dialog.getByLabel('Display name').fill('Chief Moderator');
    await dialog.getByLabel('Role').selectOption('Moderator');
    await dialog.getByRole('button', { name: 'Save member' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('Chief Moderator');
    await expect(row).toContainText('Moderator');
    await edit.click();
    await dialog.getByLabel('New password').fill('Reset-Password-2!');
    await dialog.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'signed out everywhere' })).toBeVisible();

    // Delete, after a confirmation.
    await row.getByRole('button', { name: /Delete .e2e\.manage./ }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'e2e.manage' })).toHaveCount(0);
    // The duplicate username's 400 was the point; nothing else may fail.
    expect(watched.consoleErrors.filter((message) => !/status of 400/.test(message))).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test('the Members tab fits every width, and 300 px at 2× text (UI-12)', async ({ page, request }) => {
    await createMember(request, 'wide.member.with.a.long.username.for.layout', 'Player');
    for (const width of [300, 520, 640, 760, 1180]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/admin');
      await page.getByRole('tab', { name: 'Members' }).click();
      await expect(page.getByRole('row').nth(1)).toBeVisible();
      await expectNoHorizontalScroll(page, `members at ${width}px`);
    }
  });
});

test.describe('members', () => {
  test('sign in as each role, see who they are, and sign out', async ({ page, playwright }) => {
    const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
    for (const role of ['Player', 'Editor', 'Moderator']) await createMember(admin, `e2e.${role.toLowerCase()}`, role);
    await admin.dispose();

    const watched = await watchPage(page);
    for (const role of ['Player', 'Editor', 'Moderator']) {
      await page.goto('/');
      await page.getByRole('link', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\?page=login$/);
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();
      if (role === 'Player') {
        await expectAccessible(page, 'sign-in page');
        await page.getByLabel('Username').fill('e2e.player');
        await page.getByLabel('Password').fill('Wrong-Password-9!');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('alert')).toHaveText('The username or password is wrong.');
      }
      await page.getByLabel('Username').fill(`E2E.${role}`);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('status').filter({ hasText: `Signed in as Traveller e2e.${role.toLowerCase()}.` })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
      await expect(page.getByText(`Traveller e2e.${role.toLowerCase()} · ${role}`)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);

      // The account menu: who is signed in, and Sign out.
      const account = page.getByRole('button', { name: 'Account' });
      if (role === 'Player') await expectDialogBehaviour(page, account, 'Account');
      await account.click();
      const dialog = page.getByRole('dialog', { name: 'Account' });
      await expect(dialog).toContainText(role);
      if (role === 'Player') await expectAccessible(page, 'account menu');
      await dialog.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'You have signed out.' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    }
    expect(watched.consoleErrors.filter((message) => !/status of 401/.test(message))).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test('a member changes their password, and a signed-in member skips the sign-in page', async ({ page, playwright }) => {
    const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
    await createMember(admin, 'e2e.changer', 'Player');
    await admin.dispose();
    await page.goto('/?page=login');
    await page.getByLabel('Username').fill('e2e.changer');
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Account' });
    await dialog.getByLabel('Current password').fill(password);
    await dialog.getByLabel('New password', { exact: true }).fill('Changed-Password-3!');
    await dialog.getByLabel('Confirm new password').fill('Changed-Password-3!');
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(dialog.getByText('The password was changed. Your other sessions have been signed out.')).toBeVisible();
    await page.keyboard.press('Escape');
    // Still signed in with the new session; the sign-in page sends a member back to the game.
    await page.goto('/?page=login');
    await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the header and sign-in page fit 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale: '2' })));
    await page.setViewportSize({ width: 300, height: 800 });
    await page.goto('/?page=login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectNoHorizontalScroll(page, 'sign-in page at 300px, 2×');
  });
});
