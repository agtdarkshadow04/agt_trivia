import { expect, test } from '@playwright/test';
import { setupPassword } from './environment';
import { admin, adminState, expectAccessible, watchPage } from './fixtures';

/**
 * First run through the UI (AUTH-5, AUTH-6, TEST-6): the setup project creates
 * the Admin with the setup password and saves the signed-in state the other
 * tests use.
 */
test('first-run setup creates the Admin and signs it in', async ({ page }) => {
  const watched = await watchPage(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Create the Admin account' })).toBeVisible();
  await expectAccessible(page, 'setup screen');

  // The browser checks the form with the server's own rules first (FE-6).
  await page.getByLabel('Setup password').fill(setupPassword);
  await page.getByLabel('Admin username').fill(admin.username);
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('Confirm new password').fill('different');
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByText('Password must be at least 12 characters.')).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Password confirmation does not match.')).toBeVisible();

  // The server's answer is translated too: a wrong setup password.
  await page.getByLabel('Setup password').fill('not-the-setup-password');
  await page.getByLabel('New password', { exact: true }).fill(admin.password);
  await page.getByLabel('Confirm new password').fill(admin.password);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByRole('alert')).toHaveText('The setup password is wrong.');

  await page.getByLabel('Setup password').fill(setupPassword);
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByRole('tablist', { name: 'Administration sections' })).toBeVisible();
  // AUTH-6: the setup password is still set, so the dashboard reminds the Admin.
  await expect(page.getByText(/AGT_TRIVIA_SETUP_PASSWORD is still set/)).toBeVisible();
  await expect(page.getByText(admin.username, { exact: true })).toBeVisible();
  expect(watched.consoleErrors).toEqual([]);
  expect(await watched.violations()).toEqual([]);
  await page.context().storageState({ path: adminState });
});
