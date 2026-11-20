import { expect, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Category management (#20): a Moderator creates, edits and deletes a
 * category, and cannot delete one with questions. The test deletes the
 * category it creates, so the seeded quiz the other specs count stays as it
 * was.
 */

const password = 'Member-Password-1!';

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  for (const [username, role] of [['e2e.curator', 'Moderator'], ['e2e.writer', 'Editor']]) {
    const response = await admin.post('/api/admin/members', {
      headers: { 'x-agt-request': '1' },
      data: { username, displayName: `Traveller ${username}`, role, password },
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

const card = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('a Moderator creates and edits a category, cannot delete one with questions, and deletes an empty one', async ({ page }) => {
  const watched = await watchPage(page);
  await signIn(page, 'e2e.curator');
  await page.getByRole('link', { name: 'Categories' }).click();
  await expect(page).toHaveURL(/\?page=categories$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeFocused();
  // In display order, with the questions counted by status.
  await expect(page.getByRole('article').first()).toContainText('Space');
  await expect(card(page, 'Space').getByRole('definition').first()).toHaveText('12');
  await expect(card(page, 'Empty')).toContainText('Draft');
  await expectAccessible(page, 'categories page');

  // Create: the browser checks with the server's rules first (FE-6), the server refuses a name in use.
  const create = page.getByRole('button', { name: 'New category' });
  await expectDialogBehaviour(page, create, 'New category');
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'New category' });
  await dialog.getByLabel('Short name').fill('with space');
  await dialog.getByRole('button', { name: 'Save category' }).click();
  await expect(dialog.getByLabel('Short name')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('Short name').fill('SPACE');
  await dialog.getByLabel('Name', { exact: true }).fill('Galaxies');
  await dialog.getByLabel('Description').fill('Spirals, ellipticals and everything between.');
  await dialog.getByLabel('Priority').fill('5');
  await dialog.getByRole('button', { name: 'Save category' }).click();
  await expect(dialog.getByLabel('Short name')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog).toContainText('Short name is already in use.');
  await dialog.getByLabel('Short name').fill('galaxies');
  await dialog.getByRole('button', { name: 'Save category' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Category created.' })).toBeVisible();
  // Priority 5 comes before Space (10).
  await expect(page.getByRole('article').first()).toContainText('Galaxies');
  await expect(card(page, 'Galaxies')).toContainText('galaxies · priority 5');

  // Edit: a new short name warns that old links break.
  await card(page, 'Galaxies').getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Galaxies' });
  await expectAccessible(page, 'category dialog');
  await edit.getByLabel('Short name').fill('galaxy');
  await expect(edit.getByText('Changing the short name breaks links that use the old one (/?category=galaxies).')).toBeVisible();
  await edit.getByLabel('Priority').fill('90');
  await edit.getByRole('button', { name: 'Save category' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Category saved.' })).toBeVisible();
  await expect(card(page, 'Galaxies')).toContainText('galaxy · priority 90');
  await expect(page.getByRole('article').last()).toContainText('Galaxies');

  // Editors can now file questions under it.
  const writer = await page.context().browser()!.newPage();
  await signIn(writer, 'e2e.writer');
  await writer.goto('/?page=questions');
  await writer.getByRole('button', { name: 'New question' }).click();
  await expect(writer.getByLabel('Category').getByRole('option', { name: 'Galaxies' })).toHaveCount(1);
  await writer.close();

  // A category with questions cannot be deleted.
  await card(page, 'Space').getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Delete category' }).click();
  await expect(page.getByRole('alert')).toHaveText('This category still has 12 questions. Move them to another category or delete them first.');
  await expect(card(page, 'Space')).toBeVisible();

  // An empty one can.
  await card(page, 'Galaxies').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete category' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Category deleted.' })).toBeVisible();
  await expect(card(page, 'Galaxies')).toHaveCount(0);

  // The refused delete's 409 was the point; nothing else may fail.
  expect(watched.consoleErrors.filter((message) => !/status of (400|409)/.test(message))).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('only Moderators have the Categories page', async ({ page }) => {
  await signIn(page, 'e2e.writer');
  await expect(page.getByRole('link', { name: 'Categories' })).toHaveCount(0);
  await page.goto('/?page=categories');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('the Categories page fits every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
  await signIn(page, 'e2e.curator');
  for (const [scale, widths] of [['1', [300, 520, 760, 1180]], ['2', [300]]] as const) {
    await page.addInitScript((fontScale) => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale })), scale);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?page=categories');
      await expect(card(page, 'Space')).toBeVisible();
      await expectNoHorizontalScroll(page, `categories at ${width}px, ${scale}×`);
      await card(page, 'Space').getByRole('button', { name: 'Edit' }).click();
      await expectNoHorizontalScroll(page, `category dialog at ${width}px, ${scale}×`);
    }
  }
});
