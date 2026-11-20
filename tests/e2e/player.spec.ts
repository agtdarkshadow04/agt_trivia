import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, preferences, watchPage } from './fixtures';

/**
 * The player UI (#16) on the quiz `setup.spec.ts` seeds: Space (12
 * questions), Biology (3, the last one multi-answer) and Empty (none
 * approved). Correct answers start with "Right" or "Also right".
 */

const widths = [300, 520, 640, 760, 1180];

/** Answers the current question right (or wrong) by choosing answers by their text, then locks it. */
async function answer(page: Page, right: boolean) {
  await expect(page.getByRole('button', { name: 'Lock answer' })).toBeVisible();
  const multi = await page.getByText('Select every correct answer').isVisible();
  const role = multi ? 'checkbox' : 'radio';
  const pattern = right ? /^[A-D]?\s*(Also right|Right)/ : /^[A-D]?\s*Wrong/;
  const options = page.getByRole(role, { name: pattern });
  if (right) for (const option of await options.all()) await option.check();
  else await options.first().check();
  await page.getByRole('button', { name: 'Lock answer' }).click();
}

test('lists the categories in order, with the empty one disabled', async ({ page }) => {
  const watched = await watchPage(page);
  await page.goto('/');
  await expect(page).toHaveTitle('AGT Galactic Trivia');
  await expect(page.getByRole('heading', { level: 1, name: 'Choose a category' })).toBeVisible();
  const cards = page.getByRole('listitem').getByRole('button');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('space · Questions: 12');
  await expect(cards.nth(0)).toContainText('Planets, stars and the void between them.');
  await expect(cards.nth(1)).toContainText('Biology');
  await expect(cards.nth(2)).toContainText('No questions yet');
  await expect(cards.nth(2)).toBeDisabled();
  await expect(page.getByText('Questions in all: 15')).toBeVisible();
  // UI-7: the support link and the settings button.
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Support' })).toHaveAttribute('href', 'https://support.example.org/trivia');
  await expectAccessible(page, 'category list');
  expect(watched.consoleErrors).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('plays a quiz with single- and multi-answer questions, then replays and chooses another', async ({ page }) => {
  const watched = await watchPage(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Biology/ }).click();
  await expect(page).toHaveURL(/\?category=bio$/);
  await expect(page.getByRole('heading', { name: 'Choose quiz length' })).toBeFocused();
  await expect(page.getByText('Questions available: 3')).toBeVisible();
  // #43: with 3 questions a short or long quiz would be the full one, so only the full quiz is offered.
  await expect(page.getByRole('button', { name: /(Short|Long) quiz/ })).toHaveCount(0);
  await expectAccessible(page, 'length choice');
  await page.getByRole('button', { name: /Full quiz/ }).click();

  // The quiz order is random: the multi-answer question is answered right, and of the two single-answer
  // ones the first right and the second wrong, whatever their positions, so the score is always 2 of 3.
  let singleAnsweredRight = false;
  for (let number = 1; number <= 3; number += 1) {
    await expect(page.getByText(`Question ${number} of 3`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lock answer' })).toBeDisabled();
    const multi = await page.getByText('Select every correct answer').isVisible();
    const right = multi || !singleAnsweredRight;
    if (!multi && right) singleAnsweredRight = true;
    if (number === 1) await expectAccessible(page, 'question');
    await answer(page, right);
    const feedback = page.getByRole('status').filter({ hasText: right ? 'Correct!' : 'Not quite' });
    await expect(feedback).toBeVisible();
    if (!right) await expect(feedback).toContainText(/The correct answer: Right/);
    // A11Y-1: a locked answer's state is words, not only colour.
    await expect(page.getByText(right ? 'Your answer: correct' : 'Your answer: incorrect').first()).toBeVisible();
    if (multi) await expect(page.getByText('Submitted by Traveller Ada')).toBeVisible();
    await expectAccessible(page, `feedback ${number}`);
    await page.getByRole('button', { name: number === 3 ? 'View results' : 'Next question' }).click();
  }

  const results = page.getByRole('heading', { level: 1 });
  await expect(results).toBeFocused();
  const ring = page.getByRole('img', { name: /of 3 correct/ });
  await expect(ring).toBeVisible();
  const score = Number((await ring.getAttribute('aria-label'))!.match(/^(\d)/)![1]);
  expect(score).toBe(2);
  await expect(results).toHaveText('Seasoned Traveller');
  await expect(page.getByText('You completed Biology with a score of 67%.')).toBeVisible();
  await expectAccessible(page, 'results');

  // #44: the review lists every question with the player's answer; it is closed until opened.
  const review = page.locator('details.answer-review');
  const items = review.getByRole('listitem');
  await expect(items.first()).toBeHidden();
  await review.getByText('Review your answers').click();
  await expect(items).toHaveCount(3);
  const right = items.filter({ hasText: 'Your answer: correct' });
  await expect(right).toHaveCount(2);
  await expect(right.filter({ hasText: /The correct answers?:/ })).toHaveCount(0);
  const wrong = items.filter({ hasText: 'Your answer: incorrect' });
  await expect(wrong).toHaveCount(1);
  await expect(wrong).toContainText(/You chose: Wrong/);
  await expect(wrong).toContainText(/The correct answer: Right/);
  await expectAccessible(page, 'answer review');

  await page.getByRole('button', { name: 'Replay category' }).click();
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  await expect(page.getByText('Score: 0')).toBeVisible();
  await page.getByRole('button', { name: 'Categories' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeFocused();
  expect(watched.consoleErrors).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('plays with the keyboard alone (A11Y-5)', async ({ page }) => {
  await page.goto('/?category=bio');
  await page.getByRole('heading', { name: 'Choose quiz length' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Full quiz/ })).toBeFocused();
  await page.keyboard.press('Enter');
  for (let number = 1; number <= 3; number += 1) {
    await expect(page.getByText(`Question ${number} of 3`)).toBeVisible();
    await expect(page.locator('h1')).toBeFocused();
    // Tab reaches the first answer; Space chooses it (a radio button or a checkbox).
    await page.keyboard.press('Tab');
    await expect(page.locator('.answer input').first()).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('.answer input').first()).toBeChecked();
    // Enter submits the form and locks the answer; focus moves on to the next step, and Enter takes it.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: number === 3 ? 'View results' : 'Next question' })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('img', { name: /of 3 correct/ })).toBeVisible();
});

test('follows deep links, ignoring case, and falls back to the list (FE-4)', async ({ page }) => {
  await page.goto('/?category=BIO');
  await expect(page.getByRole('heading', { name: 'Choose quiz length' })).toBeVisible();
  await expect(page).toHaveURL(/\?category=bio$/);

  await page.goto('/?category=nope');
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'There is no category “nope”. Choose one below.' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/?category=empty');
  await expect(page.getByText('The category “empty” has no questions yet. Choose another one below.')).toBeVisible();

  // Back and Forward move between the list and a category.
  await page.goto('/');
  await page.getByRole('button', { name: /Space/ }).click();
  await expect(page).toHaveURL(/\?category=space$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Choose quiz length' })).toBeVisible();
  // #43: Space's 12 questions give a short quiz of 10 (quiz.shortLength) and the full 12; a long quiz of
  // quiz.longLength (30) would be the full one, so it is not offered.
  const lengths = page.getByRole('listitem').getByRole('button');
  await expect(lengths).toHaveCount(2);
  await expect(lengths.nth(0)).toContainText('Short quiz');
  await expect(lengths.nth(0)).toContainText('Questions: up to 10');
  await expect(lengths.nth(1)).toContainText('Full quiz');
  await page.getByRole('button', { name: /Short quiz/ }).click();
  await expect(page.getByText('Question 1 of 10')).toBeVisible();
});

test('shows a load error with a retry (FE-5)', async ({ page }) => {
  let failed = false;
  // The server cannot fail on demand; this simulates one failure.
  await page.route('**/api/categories', async (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Boom.' }) });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Something went wrong on the server. Try again later.');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a category' })).toBeVisible();
});

test('the settings dialog changes the language, time zone and text size (I18N-4, A11Y-2, A11Y-6)', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await expectDialogBehaviour(page, opener, 'Settings');
  await opener.click();
  // The dialog is found by its role: its title follows the language.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Settings');
  // The time zone formats the score history's dates (#21).
  await expect(dialog.getByLabel('Time zone')).toHaveValue('auto');
  await expectAccessible(page, 'settings dialog');
  await dialog.getByLabel('Language').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: 'Choisissez une catégorie' })).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Paramètres');
  await dialog.getByLabel('Taille du texte').selectOption('1.5');
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1.5');
  await page.keyboard.press('Escape');
  // Question and category text stays English.
  await expect(page.getByText('Biology', { exact: true })).toBeVisible();
});

test('every locale renders the player with no missing text', async ({ page }) => {
  for (const language of ['de', 'th', 'zh', 'hi', 'ja', 'pt']) {
    await preferences(page, { language });
    await page.goto('/?category=bio');
    await expect(page.locator('html')).toHaveAttribute('lang', language === 'pt' ? 'pt-BR' : language);
    await expect(page.locator('h1')).not.toHaveText('');
    await expect(page.locator('h1')).not.toHaveText('Choose quiz length');
  }
});

test('every view fits every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
  const views: [string, (page: Page) => Promise<void>][] = [
    ['category list', async () => { await page.goto('/'); }],
    ['length choice', async () => { await page.goto('/?category=bio'); }],
    ['question', async () => { await page.goto('/?category=bio'); await page.getByRole('button', { name: /Full quiz/ }).click(); await answer(page, false); }],
    ['results', async () => {
      await page.goto('/?category=bio');
      await page.getByRole('button', { name: /Full quiz/ }).click();
      for (let number = 1; number <= 3; number += 1) {
        await answer(page, true);
        await page.getByRole('button', { name: number === 3 ? 'View results' : 'Next question' }).click();
      }
      await expect(page.getByRole('heading', { name: 'Atlas Archivist' })).toBeVisible();
      await page.getByText('Review your answers').click();
      await expect(page.locator('.review-item').first()).toBeVisible();
    }],
  ];
  for (const [scale, sizes] of [['1', widths], ['2', [300]]] as const) {
    await preferences(page, { fontScale: scale });
    for (const width of sizes) {
      await page.setViewportSize({ width, height: 800 });
      for (const [name, show] of views) {
        await show(page);
        await expectNoHorizontalScroll(page, `${name} at ${width}px, ${scale}×`);
      }
    }
  }
});
