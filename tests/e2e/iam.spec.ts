import { expect, test } from '@playwright/test';
import { adminState, expectAccessible, watchPage } from './fixtures';

/**
 * AGT sign-in (#18) against the fake AGT IAM (`fake-iam.ts`): the Admin turns
 * it on in Settings, travellers sign in with their AGT account, and the
 * Admin sees and limits AGT members. Runs serially: it switches a setting the
 * other tests share.
 */

test.describe.configure({ mode: 'serial' });

const vegaPassword = 'Vega "Star", +1\\';

async function setAgtSignIn(page: import('@playwright/test').Page, enabled: boolean) {
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Settings' }).click();
  const box = page.getByLabel('Let members sign in with their AGT account (AGT IAM)');
  if ((await box.isChecked()) !== enabled) {
    await box.setChecked(enabled);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The settings were saved.' })).toBeVisible();
  }
}

test.describe('the Admin', () => {
  test.use({ storageState: adminState });

  test('turns AGT sign-in on in Settings, which shows that AGT IAM is configured', async ({ page }) => {
    await setAgtSignIn(page, true);
    await expect(page.getByText('AGT IAM is configured.')).toBeVisible();
    await expectAccessible(page, 'settings with AGT sign-in');
  });
});

test.describe('travellers', () => {
  test('sign in with their AGT account, the tier setting the role', async ({ page }) => {
    const watched = await watchPage(page);
    await page.goto('/?page=login');
    await page.getByLabel('AGT account').check();
    await expect(page.getByText(/AGT IAM checks them; AGT Galactic Trivia never stores your AGT password/)).toBeVisible();
    await expectAccessible(page, 'AGT sign-in form');

    // A tier AGT IAM refuses, translated; nothing is created.
    await page.getByLabel('Traveller Name').fill('Locked Out');
    await page.getByLabel('Password').fill('Locked-Out-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Your AGT account is not authorized for AGT Galactic Trivia.');

    await page.getByLabel('Traveller Name').fill('Vega Ranger');
    await page.getByLabel('Password').fill(vegaPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Vega Ranger · Moderator')).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Account' });
    // An AGT member has no password here.
    await expect(dialog.getByText(/change its password with AGT, not here/)).toBeVisible();
    await expect(dialog.getByLabel('Current password')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Sign out' }).click();

    // A tier the role map does not name signs in as a Player.
    await page.goto('/?page=login');
    await page.getByLabel('AGT account').check();
    await page.getByLabel('Traveller Name').fill('Plain Traveller');
    await page.getByLabel('Password').fill('Plain-Traveller-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Plain Traveller · Player')).toBeVisible();
    expect(watched.consoleErrors.filter((message) => !/status of (401|403)/.test(message))).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });
});

test.describe('the Admin, afterwards', () => {
  test.use({ storageState: adminState });

  test('sees AGT members, may only activate, deactivate or delete them, and turns AGT sign-in off', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('tab', { name: 'Members' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Vega Ranger' });
    await expect(row).toContainText('AGT account · Moderator');
    await row.getByRole('button', { name: 'Edit Vega Ranger' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Vega Ranger' });
    await expect(dialog.getByText(/AGT IAM sets their name and role at every sign-in/)).toBeVisible();
    await expect(dialog.getByText('AGT-E2E-1')).toBeVisible();
    await expect(dialog.getByLabel('Display name')).toHaveCount(0);
    await expect(dialog.getByLabel('New password')).toHaveCount(0);
    await expectAccessible(page, 'AGT member editor');
    await page.keyboard.press('Escape');

    await setAgtSignIn(page, false);
    await page.goto('/?page=login');
    await expect(page.getByLabel('AGT account')).toHaveCount(0);
  });
});
