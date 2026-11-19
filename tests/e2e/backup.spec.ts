import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { admin, adminState, expectAccessible, watchPage } from './fixtures';

/**
 * The Backup & restore tab (BAK-1, BAK-3, BAK-4) and the maintenance notice
 * (FE-5). A restore signs every session out, the saved Admin state included,
 * so the restore test signs in again and saves the new state for the spec
 * files that run after this one.
 */

test.use({ storageState: adminState });

test('downloads a backup, refuses a damaged one, previews and restores it, then asks to sign in again', async ({ page }, testInfo) => {
  const watched = await watchPage(page);
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Backup & restore' }).click();
  await expect(page.getByRole('heading', { name: 'Download backup' })).toBeVisible();
  await expectAccessible(page, 'backup tab');

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^agt-trivia-backup-.*\.zip$/);
  const backupPath = testInfo.outputPath('backup.zip');
  await download.saveAs(backupPath);

  // A file that is not a backup: the translated reason, the English details kept for support.
  const preview = page.getByRole('button', { name: 'Preview backup' });
  await expect(preview).toBeDisabled();
  await page.getByLabel('Backup file').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await preview.click();
  const rejected = page.getByRole('alert').filter({ hasText: 'This backup cannot be restored.' });
  await expect(rejected).toContainText('This backup cannot be restored. The file is not a ZIP archive.');
  await rejected.getByText('Technical details').click();
  await expect(rejected).toContainText('The file is not a ZIP archive:');

  // The real backup: a preview first, then a confirmed restore.
  await page.getByLabel('Backup file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: readFileSync(backupPath) });
  await preview.click();
  const previewSection = page.getByRole('region', { name: 'Backup preview' });
  await expect(previewSection).toBeVisible();
  await expect(previewSection.getByText('Admin account')).toBeVisible();
  await expect(previewSection.getByText("The backup's file is identical to the current one.")).toBeVisible();
  await expectAccessible(page, 'backup preview');
  const restore = previewSection.getByRole('button', { name: 'Restore backup' });
  await expect(restore).toBeDisabled();
  await previewSection.getByLabel(/I understand/).check();
  await restore.click();
  await expect(page.getByRole('heading', { name: 'Backup restored' })).toBeVisible();
  await expect(page.getByText(/^The replaced data was saved first as pre-restore-backup-.*\.zip/)).toBeVisible();

  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page.getByText(/^The backup was restored\./)).toBeVisible();
  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tablist', { name: 'Administration sections' })).toBeVisible();
  await page.context().storageState({ path: adminState });
  expect(watched.consoleErrors.filter((message) => !/status of (422|401)/.test(message))).toEqual([]);
  expect(await watched.violations()).toEqual([]);
});

test('shows the maintenance notice while the server answers 503, and retries (FE-5)', async ({ page }) => {
  let answered = false;
  // The server produces 503 maintenance only during a restore; this simulates one for the first request.
  await page.route('**/api/admin/settings', async (route) => {
    if (answered) return route.continue();
    answered = true;
    return route.fulfill({
      status: 503,
      headers: { 'retry-after': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'maintenance', message: 'Maintenance in progress.', params: { retryAfterSeconds: 1 } }),
    });
  });
  await page.goto('/admin');
  await expect(page.getByText(/^Maintenance in progress: the server is busy with a backup or restore\./)).toBeVisible();
  await expect(page.getByLabel('Questions in a long quiz')).toBeVisible();
  await expect(page.getByText(/^Maintenance in progress/)).toBeHidden();
});
