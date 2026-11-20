import { expect, type APIRequestContext, type Page, test } from '@playwright/test';
import { adminState, expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, watchPage } from './fixtures';

/**
 * Question reports (#46): a member reports questions while playing and from
 * the end-of-quiz review, a second report of the same question is refused,
 * and a Moderator resolves one and dismisses the other on the review page.
 * The test closes every report it opens, so the review count other specs see
 * stays as it was.
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

/** Answers the current question with its first answer, locks it and moves on. */
async function answerAny(page: Page, last: boolean) {
  await page.locator('.answer input').first().check();
  await page.getByRole('button', { name: 'Lock answer' }).click();
  await page.getByRole('button', { name: last ? 'View results' : 'Next question' }).click();
}

const reportButtons = (page: Page) => page.getByRole('button', { name: /^Report a problem with/ });

test.beforeAll(async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: adminState });
  await createMember(admin, 'e2e.reporter', 'Player');
  await createMember(admin, 'e2e.handler', 'Moderator');
  await admin.dispose();
});

test('a member reports questions, and a Moderator resolves and dismisses the reports', async ({ browser }) => {
  const playerContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  const player = await playerContext.newPage();
  const moderator = await moderatorContext.newPage();
  const watchedPlayer = await watchPage(player);
  const watchedModerator = await watchPage(moderator);

  // While playing: the dialog behaves (A11Y-2), a reason is required, then the report is sent.
  await signIn(player, 'e2e.reporter');
  await player.goto('/?category=bio');
  await player.getByRole('button', { name: /Full quiz/ }).click();
  const firstPrompt = (await player.locator('h1.question-prompt').textContent())!;
  const report = reportButtons(player);
  await expect(report).toHaveCount(1);
  await expect(report).toHaveAccessibleName(`Report a problem with “${firstPrompt}”`);
  await expectDialogBehaviour(player, report, 'Report a problem');
  await report.click();
  const dialog = player.getByRole('dialog', { name: 'Report a problem' });
  await expectAccessible(player, 'report dialog');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.locator('.field-error')).toContainText('Reason');
  await dialog.getByLabel('Reason').selectOption({ label: 'The question is unclear' });
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog).toBeHidden();
  await expect(player.getByRole('status').filter({ hasText: 'Thanks! A Moderator will look at your report.' })).toBeVisible();
  await expect(report).toBeDisabled();

  for (let number = 1; number <= 3; number += 1) await answerAny(player, number === 3);
  await player.getByText('Review your answers').click();
  const items = player.locator('.review-item');
  await expect(items).toHaveCount(3);

  // The same question again from the review: "Something else" needs details, then the server refuses a second report.
  await items.filter({ hasText: firstPrompt }).getByRole('button', { name: /^Report a problem/ }).click();
  await dialog.getByLabel('Reason').selectOption({ label: 'Something else' });
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.locator('.field-error')).toContainText('Details');
  await dialog.getByLabel('Details').fill('Testing a second report.');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('You have already reported this question. A Moderator will look at it.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Another question from the review, with a note.
  const other = items.filter({ hasNotText: firstPrompt }).first();
  const otherPrompt = (await other.locator('.review-item-prompt').textContent())!;
  await other.getByRole('button', { name: /^Report a problem/ }).click();
  await dialog.getByLabel('Reason').selectOption({ label: 'A spelling or typing mistake' });
  await dialog.getByLabel('Details').fill('One answer is misspelt.');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(other.getByRole('status')).toHaveText('Thanks! A Moderator will look at your report.');

  // The Moderator sees both on the review page, oldest first, and closes them.
  await signIn(moderator, 'e2e.handler');
  await moderator.getByRole('link', { name: /^Review queue: \d+ waiting$/ }).click();
  const panel = moderator.locator('.reports-panel');
  await expect(panel.getByRole('heading', { level: 2, name: 'Reported questions' })).toBeVisible();
  const cards = panel.getByRole('article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText(firstPrompt);
  await expect(cards.nth(0)).toContainText('The question is unclear');
  await expect(cards.nth(0)).toContainText('Reported by Traveller e2e.reporter on');
  await expect(cards.nth(1)).toContainText(otherPrompt);
  await expect(cards.nth(1)).toContainText('One answer is misspelt.');
  await expectAccessible(moderator, 'reported questions');

  const resolve = cards.nth(0).getByRole('button', { name: 'Mark resolved' });
  await expectDialogBehaviour(moderator, resolve, 'Mark this report resolved?');
  await resolve.click();
  const closeDialog = moderator.getByRole('dialog', { name: 'Mark this report resolved?' });
  await closeDialog.getByLabel('Note for the record').fill('Reworded the question.');
  await closeDialog.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Report marked resolved.' })).toBeVisible();
  await expect(cards).toHaveCount(1);
  await cards.nth(0).getByRole('button', { name: 'Dismiss' }).click();
  await moderator.getByRole('dialog', { name: 'Dismiss this report?' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Report dismissed.' })).toBeVisible();
  await expect(panel.getByText('No open reports.')).toBeVisible();

  expect(watchedPlayer.consoleErrors.filter((message) => !/status of 409/.test(message))).toEqual([]);
  expect(await watchedPlayer.violations()).toEqual([]);
  expect(watchedModerator.consoleErrors).toEqual([]);
  expect(await watchedModerator.violations()).toEqual([]);
  await playerContext.close();
  await moderatorContext.close();
});

test('visitors cannot report, and nothing about reports is shown to them', async ({ page }) => {
  await page.goto('/?category=bio');
  await page.getByRole('button', { name: /Full quiz/ }).click();
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  await expect(reportButtons(page)).toHaveCount(0);
  for (let number = 1; number <= 3; number += 1) await answerAny(page, number === 3);
  await page.getByText('Review your answers').click();
  await expect(page.locator('.review-item')).toHaveCount(3);
  await expect(reportButtons(page)).toHaveCount(0);
});

test('the report dialog and the reported questions fit every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ browser }) => {
  const playerContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  const player = await playerContext.newPage();
  const moderator = await moderatorContext.newPage();
  await signIn(player, 'e2e.reporter');
  await signIn(moderator, 'e2e.handler');
  // An open report to show: one of Biology's questions, reported through the API with the member's own session.
  const categories = await (await player.request.get('/api/categories')).json() as { id: string; shortName: string }[];
  const biology = categories.find((category) => category.shortName === 'bio')!;
  const quiz = await (await player.request.get(`/api/categories/${biology.id}/quiz?length=all`)).json() as { questions: { id: string }[] };
  const created = await player.request.post(`/api/member/questions/${quiz.questions[0].id}/reports`, {
    headers: { 'x-agt-request': '1' },
    data: { reason: 'outdated', note: 'A long note that should wrap nicely on a narrow screen without scrolling sideways at all.' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id, version } = await created.json() as { id: string; version: number };

  for (const [scale, widths] of [['1', [300, 520, 760, 1180]], ['2', [300]]] as const) {
    for (const page of [player, moderator]) {
      await page.addInitScript((fontScale) => localStorage.setItem('agt_trivia_settings', JSON.stringify({ fontScale })), scale);
    }
    for (const width of widths) {
      await player.setViewportSize({ width, height: 800 });
      await player.goto('/?category=bio');
      await player.getByRole('button', { name: /Full quiz/ }).click();
      await reportButtons(player).click();
      await expect(player.getByRole('dialog', { name: 'Report a problem' })).toBeVisible();
      await expectNoHorizontalScroll(player, `report dialog at ${width}px, ${scale}×`);
      await moderator.setViewportSize({ width, height: 800 });
      await moderator.goto('/?page=review');
      await expect(moderator.locator('.reports-panel').getByRole('article')).toHaveCount(1);
      await expectNoHorizontalScroll(moderator, `reported questions at ${width}px, ${scale}×`);
    }
  }
  const dismissed = await moderator.request.post(`/api/member/reports/${id}/dismiss`, { headers: { 'x-agt-request': '1' }, data: { version, resolutionNote: '' } });
  expect(dismissed.status(), await dismissed.text()).toBe(200);
  await playerContext.close();
  await moderatorContext.close();
});
