import { expect, test } from '@playwright/test';
import { adminState, expectAccessible, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * The Admin's sheet import (#22) with the fixtures cut from the 1.x sheet's
 * CSV downloads: preview, import, a second preview with nothing new, and a
 * file with bad rows. Afterwards a Moderator deletes what the import added, so
 * the seeded quiz the other specs count stays as it was.
 */

const categoriesFile = 'tests/fixtures/sheet/validCategories.csv';
const questionsFile = 'tests/fixtures/sheet/pendingQuestions.csv';
const imported = ['Alliance of Galactic Travellers', 'Hyades Travellers Foundation', "No Man's Sky"];

test.use({ storageState: adminState });

test('the Admin previews and imports the sheet, and a second import adds nothing', async ({ page, playwright }) => {
  const watched = await watchPage(page);
  await page.goto('/admin');
  // UI-8: Import comes right before Backup & restore.
  const tabs = page.getByRole('tab');
  await expect(tabs.nth(4)).toHaveText('Import');
  await expect(tabs.nth(5)).toHaveText('Backup & restore');
  await page.getByRole('tab', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import from the Google Sheet' })).toBeVisible();
  await expect(page.getByText('Download a backup on the Backup & restore tab first.')).toBeVisible();
  await expectAccessible(page, 'import tab');

  await page.getByLabel('Categories (validCategories.csv)').setInputFiles(categoriesFile);
  await page.getByLabel('Questions (pendingQuestions.csv)').setInputFiles(questionsFile);
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('region', { name: 'What the import will do' });
  await expect(preview).toContainText('Every row can be imported.');
  const count = (label: string) => preview.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd');
  await expect(count('New categories')).toHaveText('3');
  await expect(count('New questions')).toHaveText('11');
  await expect(count('Of them approved')).toHaveText('11');
  await expectAccessible(page, 'import preview');

  await preview.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The import is done: 3 categories and 11 questions were added.' })).toBeVisible();

  // The questions are in the game.
  const player = await page.context().browser()!.newPage();
  await player.goto('/?category=HTF');
  await expect(player.getByText('Questions available: 8')).toBeVisible();
  await player.close();

  // Importing again finds everything already there.
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('There is nothing new to import.')).toBeVisible();
  await expect(count('Categories already here')).toHaveText('3');
  await expect(count('Questions already here')).toHaveText('11');

  // A file with bad rows names each one, and offers no Import.
  await page.getByLabel('Categories (validCategories.csv)').setInputFiles([]);
  await page.getByLabel('Questions (pendingQuestions.csv)').setInputFiles({
    name: 'pendingQuestions.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('category,isApproved,adminNotes,isMultiAnswer,question,answers,correctAnswer,author\nNowhere,TRUE,,FALSE,Lost?,"Yes, No",Yes,x\nHyades Travellers Foundation,TRUE,,FALSE,New?,"Yes, No",Maybe,x\n'),
  });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Rows to fix: 2' })).toBeVisible();
  const problems = page.locator('.import-problems li');
  await expect(problems.nth(0)).toContainText('questions.csv row 2, category:');
  await expect(problems.nth(0)).toContainText('Nowhere');
  await expect(problems.nth(1)).toContainText('questions.csv row 3, correctAnswer:');
  await expect(preview.getByRole('button', { name: 'Import' })).toHaveCount(0);
  await expectAccessible(page, 'import problems');

  for (const width of [300, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoHorizontalScroll(page, `import tab at ${width}px`);
  }
  expect(watched.consoleErrors).toEqual([]);
  expect(await watched.violations()).toEqual([]);

  // Clean-up: a Moderator deletes the imported questions and categories.
  const baseURL = test.info().project.use.baseURL;
  const admin = await playwright.request.newContext({ baseURL, storageState: adminState });
  const created = await admin.post('/api/admin/members', {
    headers: { 'x-agt-request': '1' },
    data: { username: 'e2e.importer', displayName: 'Importer', role: 'Moderator', password: 'Member-Password-1!' },
  });
  expect([201, 400]).toContain(created.status());
  await admin.dispose();
  const moderator = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const headers = { 'x-agt-request': '1' };
  expect((await moderator.post('/api/member/login', { headers, data: { username: 'e2e.importer', password: 'Member-Password-1!' } })).ok()).toBe(true);
  const categories = (await (await moderator.get('/api/member/categories')).json()) as { id: string; name: string; version: number }[];
  for (const category of categories.filter((entry) => imported.includes(entry.name))) {
    const page = (await (await moderator.get(`/api/member/questions?categoryId=${category.id}&limit=200`)).json()) as { items: { id: string; version: number }[] };
    for (const question of page.items) expect((await moderator.delete(`/api/member/questions/${question.id}?version=${question.version}`, { headers })).status()).toBe(204);
    expect((await moderator.delete(`/api/member/categories/${category.id}?version=${category.version}`, { headers })).status()).toBe(204);
  }
  await moderator.dispose();
});
