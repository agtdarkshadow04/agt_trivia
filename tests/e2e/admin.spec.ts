import { expect, test } from '@playwright/test';
import { lockedSupportUrl } from './environment';
import { admin, adminState, expectAccessible, expectDialogBehaviour, expectNoHorizontalScroll, preferences, watchPage } from './fixtures';

const widths = [300, 520, 640, 760, 1180];

test.describe('signed out', () => {
  test('signs in, shows wrong credentials translated, and signs out', async ({ page }) => {
    const watched = await watchPage(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
    await expectAccessible(page, 'sign-in screen');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Username is required.')).toBeVisible();
    await page.getByLabel('Username').fill(admin.username);
    await page.getByLabel('Password').fill('Wrong-Password-1!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The username or password is wrong.');
    await page.getByLabel('Password').fill(admin.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'You have signed out.' })).toBeVisible();
    expect(watched.consoleErrors).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });
});

test.describe('signed in', () => {
  test.use({ storageState: adminState });

  test('shows the version, and the tabs follow the keyboard (UI-8)', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible();
    const settings = page.getByRole('tab', { name: 'Settings' });
    await settings.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Account' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Account' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(settings).toHaveAttribute('aria-selected', 'true');
  });

  test('changes settings, keeps config.yaml\'s read-only, and checks the quiz lengths (CFG-6..CFG-9)', async ({ page, request }) => {
    await page.goto('/admin');
    const support = page.getByLabel('Support link');
    await expect(support).toHaveValue(lockedSupportUrl);
    await expect(support).toHaveAttribute('readonly', '');
    await expect(page.getByText('Set in the configuration file (site.supportUrl)', { exact: false })).toBeVisible();
    await expectAccessible(page, 'settings tab');

    await page.getByLabel('Questions in a short quiz').fill('40');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Questions in a long quiz is out of range.')).toBeVisible();

    await page.getByLabel('Questions in a short quiz').fill('12');
    await page.getByLabel('Application name').fill('Trivia Night');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
    await expect(page.getByText('Set in the dashboard · site.title', { exact: false })).toBeVisible();
    const publicSettings = await (await request.get('/api/settings/public')).json();
    expect(publicSettings).toMatchObject({ siteTitle: 'Trivia Night', quizShortLength: 12, supportUrl: lockedSupportUrl });

    // Put the defaults back for the other tests.
    await page.getByLabel('Application name').fill('AGT Galactic Trivia');
    await page.getByLabel('Questions in a short quiz').fill('10');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
  });

  test('changes the Admin password, signing other sessions out (AUTH-4)', async ({ page, browser }) => {
    const other = await browser.newContext({ storageState: adminState });
    const otherPage = await other.newPage();
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Account' }).click();
    await expectAccessible(page, 'account tab');
    const change = async (current: string, next: string) => {
      await page.getByLabel('Current password').fill(current);
      await page.getByLabel('New password', { exact: true }).fill(next);
      await page.getByLabel('Confirm new password').fill(next);
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'The password was changed.' })).toBeVisible();
    };
    await change(admin.password, 'Changed-Password-2!');
    // The saved state's session ended with the change; this page has a new one.
    await otherPage.goto('/admin');
    await expect(otherPage.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
    await change('Changed-Password-2!', admin.password);
    await page.context().storageState({ path: adminState });
    await other.close();
  });

  test('the preferences dialog changes the language and text size for both pages (I18N-4, A11Y-2, A11Y-6)', async ({ page }) => {
    await page.goto('/admin');
    const opener = page.getByRole('button', { name: 'Settings', exact: true });
    await expectDialogBehaviour(page, opener, 'Settings');
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expectAccessible(page, 'preferences dialog');
    await dialog.getByLabel('Text size').selectOption('2');
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2');
    await dialog.getByLabel('Language').selectOption('fr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('dialog', { name: 'Paramètres' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tab', { name: 'Paramètres' })).toBeVisible();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '2');
  });

  test('every locale renders the dashboard with no missing text', async ({ page }) => {
    for (const language of ['de', 'th', 'zh', 'hi', 'ja', 'pt']) {
      await preferences(page, { language });
      await page.goto('/admin');
      await expect(page.getByRole('tablist')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'pt' ? 'pt-BR' : language);
      await expect(page.getByRole('tab').first()).not.toHaveText('');
    }
  });

  test('fits every width, and 300 px at 2× text (UI-12, A11Y-6)', async ({ page }) => {
    for (const [scale, sizes] of [['1', widths], ['2', [300]]] as const) {
      await preferences(page, { fontScale: scale });
      for (const width of sizes) {
        await page.setViewportSize({ width, height: 800 });
        for (const tab of ['Settings', 'Account']) {
          await page.goto('/admin');
          await page.getByRole('tab', { name: tab }).click();
          await expectNoHorizontalScroll(page, `${tab} at ${width}px, ${scale}×`);
        }
      }
    }
  });
});
