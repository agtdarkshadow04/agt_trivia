import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Question authoring and review (#19): an Editor writes and submits a
 * question, a Moderator rejects it with a note, the Editor fixes and
 * resubmits it, the Moderator approves it, and players get it in the quiz.
 * The test deletes its question at the end, so the seeded quiz the other
 * specs count stays as it was.
 */

const password = 'Member-Password-1!';

async function createMember(request: APIRequestContext, username: string, role: string) {
  const response = await request.post('/api/admin/members', {
    headers: { 'x-agt-request': '1' },
    data: { username, displayName: `Traveller ${username}`, role, password },
  });
  // A retry runs beforeAll again: an existing member is fine.
  if (response.status() === 400) expect((await response.json()).fields[0].code).toBe('duplicate');
  else expect(response.status(), await response.text()).toBe(201);
}

async function signIn(page: Page, username: string) {
  await page.goto('/?page=login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
}

/** The card of the question whose prompt is `prompt`. */
const card = (page: Page, prompt: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: prompt, exact: true }) });

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  await createMember(admin, 'e2e.author', 'Editor');
  await createMember(admin, 'e2e.reviewer', 'Moderator');
  await createMember(admin, 'e2e.reader', 'Player');
  await admin.dispose();
});

test('an Editor writes and submits, a Moderator rejects, the Editor fixes it, the Moderator approves, and players get it', async ({ browser }) => {
  const editorContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  const editor = await editorContext.newPage();
  const moderator = await moderatorContext.newPage();
  const watchedEditor = await watchPage(editor);
  const watchedModerator = await watchPage(moderator);
  const first = 'Which moon of Saturn has a thick atmosphere?';
  const fixed = 'Which moon of Saturn has a thick nitrogen atmosphere?';

  // The Editor opens My questions from the header.
  await signIn(editor, 'e2e.author');
  await editor.getByRole('link', { name: 'My questions' }).click();
  await expect(editor).toHaveURL(/\?page=questions$/);
  await expect(editor.getByRole('heading', { level: 1, name: 'My questions' })).toBeFocused();
  await expect(editor.getByText('You have not written any questions yet.')).toBeVisible();
  await expect(editor.getByRole('link', { name: /Review queue/ })).toHaveCount(0);
  await expectAccessible(editor, 'my questions');

  // The form checks with the server's rules first (FE-6), and previews the question as players see it.
  await editor.getByRole('button', { name: 'New question' }).click();
  await expect(editor.getByRole('heading', { level: 1, name: 'New question' })).toBeFocused();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(editor.getByLabel('Category')).toHaveAttribute('aria-invalid', 'true');
  await expect(editor.getByLabel('Question', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await editor.getByLabel('Category').selectOption({ label: 'Space' });
  await editor.getByLabel('Question', { exact: true }).fill(first);
  await editor.getByLabel('Answer A', { exact: true }).fill('Titan');
  await editor.getByLabel('Answer B', { exact: true }).fill('Mimas');
  await editor.getByRole('button', { name: 'Add an answer' }).click();
  await editor.getByLabel('Answer C', { exact: true }).fill('Enceladus');
  const preview = editor.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText(first);
  await expect(preview).toContainText('Titan');
  await expect(preview).toContainText('Correct answer');
  await expect(preview).toContainText('Submitted by Traveller e2e.author');
  await expect(editor.getByText('Players see this question credited to Traveller e2e.author.')).toBeVisible();
  await expect(editor.getByRole('complementary', { name: 'Writing guidelines' })).toContainText('do not change over time');
  await expectAccessible(editor, 'question form');
  await editor.getByRole('button', { name: 'Save and submit' }).click();
  await expect(editor.getByRole('status').filter({ hasText: 'Question submitted for review.' })).toBeVisible();
  await expect(card(editor, first)).toContainText('Waiting for review');

  // The Moderator sees the count in the header and rejects the question with a note.
  await signIn(moderator, 'e2e.reviewer');
  const reviewLink = moderator.getByRole('link', { name: 'Review queue: 1 waiting' });
  await expect(reviewLink).toBeVisible();
  await reviewLink.click();
  await expect(moderator).toHaveURL(/\?page=review$/);
  await expect(moderator.getByRole('heading', { level: 1, name: 'Review queue' })).toBeFocused();
  const pending = card(moderator, first);
  await expect(pending).toContainText('Written by Traveller e2e.author');
  await expectAccessible(moderator, 'review queue');
  const reject = pending.getByRole('button', { name: 'Reject' });
  await expectDialogBehaviour(moderator, reject, 'Reject this question');
  await reject.click();
  const dialog = moderator.getByRole('dialog', { name: 'Reject this question' });
  await dialog.getByRole('button', { name: 'Reject question' }).click();
  await expect(dialog.getByLabel('Note for the author')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('Note for the author').fill('Say which gas, please.');
  await dialog.getByRole('button', { name: 'Reject question' }).click();
  await expect(moderator.getByRole('status').filter({ hasText: 'Question rejected.' })).toBeVisible();
  await expect(moderator.getByText('No questions are waiting for review.')).toBeVisible();
  await expect(moderator.getByRole('link', { name: 'Review queue', exact: true })).toBeVisible();

  // The Editor reads the note, fixes the question and submits it again.
  await editor.reload();
  const rejected = card(editor, first);
  await expect(rejected).toContainText('Rejected');
  await expect(rejected).toContainText('Say which gas, please.');
  await rejected.getByRole('button', { name: 'Edit' }).click();
  await expect(editor.getByText('Say which gas, please.')).toBeVisible();
  await editor.getByLabel('Question', { exact: true }).fill(fixed);
  await editor.getByRole('button', { name: 'Save and submit' }).click();
  await expect(editor.getByRole('status').filter({ hasText: 'Question submitted for review.' })).toBeVisible();
  // Submitted questions can still be changed, but approved ones are locked for Editors.
  await expect(card(editor, fixed).getByRole('button', { name: 'Edit' })).toBeVisible();

  // The Moderator approves it.
  await moderator.reload();
  await card(moderator, fixed).getByRole('button', { name: 'Approve' }).click();
  await expect(moderator.getByRole('status').filter({ hasText: 'Question approved.' })).toBeVisible();

  await editor.reload();
  await expect(card(editor, fixed)).toContainText('Approved');
  await expect(card(editor, fixed).getByRole('button')).toHaveCount(0);

  // Players get it in the quiz: Space now has 13 questions, all played here.
  const player = await browser.newPage();
  await player.goto('/?category=space');
  await expect(player.getByText('Questions available: 13')).toBeVisible();
  await player.getByRole('button', { name: /Full quiz/ }).click();
  let found = false;
  for (let number = 1; number <= 13; number += 1) {
    await expect(player.getByText(`Question ${number} of 13`)).toBeVisible();
    if (await player.getByRole('heading', { name: fixed }).isVisible()) {
      found = true;
      await expect(player.getByText('Submitted by Traveller e2e.author')).toBeVisible();
    }
    await player.locator('.answer input').first().check();
    await player.getByRole('button', { name: 'Lock answer' }).click();
    await player.getByRole('button', { name: number === 13 ? 'View results' : 'Next question' }).click();
  }
  expect(found).toBe(true);
  await player.close();

  // The Moderator finds it among every member's questions and deletes it, leaving the seeded quiz as it was.
  await moderator.getByRole('link', { name: 'My questions' }).click();
  await moderator.getByLabel('Show').selectOption('all');
  const approved = card(moderator, fixed);
  await approved.getByRole('button', { name: 'Delete' }).click();
  const confirm = moderator.getByRole('alertdialog');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Delete question' }).click();
  await expect(moderator.getByRole('status').filter({ hasText: 'Question deleted.' })).toBeVisible();
  await expect(card(moderator, fixed)).toHaveCount(0);

  // The empty submit's 400s were checked in the browser before sending; nothing may fail.
  expect(watchedEditor.consoleErrors).toEqual([]);
  expect(watchedModerator.consoleErrors).toEqual([]);
  expect(await watchedEditor.violations()).toEqual([]);
  expect(await watchedModerator.violations()).toEqual([]);
  await editorContext.close();
  await moderatorContext.close();
});

test('Players have no question pages, and the pages send them back to the game', async ({ page }) => {
  await signIn(page, 'e2e.reader');
  await expect(page.getByRole('link', { name: 'My questions' })).toHaveCount(0);
  await page.goto('/?page=questions');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/?page=review');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
});

test('the question pages fit every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
  await signIn(page, 'e2e.reviewer');
  for (const [scale, widths] of [['1', [300, 520, 760, 1180]], ['2', [300]]] as const) {
    await page.addInitScript((fontScale) => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale })), scale);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?page=questions');
      await expect(page.getByRole('heading', { level: 1, name: 'My questions' })).toBeVisible();
      await expectNoHorizontalScroll(page, `my questions at ${width}px, ${scale}×`);
      await page.getByRole('button', { name: 'New question' }).click();
      await page.getByRole('button', { name: 'Add an answer' }).click();
      await expectNoHorizontalScroll(page, `question form at ${width}px, ${scale}×`);
      await page.goto('/?page=review');
      await expect(page.getByRole('heading', { level: 1, name: 'Review queue' })).toBeVisible();
      await expectNoHorizontalScroll(page, `review queue at ${width}px, ${scale}×`);
    }
  }
});
