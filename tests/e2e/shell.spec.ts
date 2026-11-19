import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchPage } from './fixtures';

const entries = [
  { path: '/', name: 'public page' },
  { path: '/admin', name: 'admin page' },
];

const widths = [300, 520, 640, 760, 1180];

for (const entry of entries) {
  test(`the ${entry.name} loads without errors or CSP violations`, async ({ page }) => {
    const watched = await watchPage(page);
    const response = await page.goto(entry.path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'AGT Galactic Trivia' })).toBeAttached();
    await expect(page.getByText('Alliance of Galactic Travellers').first()).toBeVisible();
    // The bundled fonts load from the server (UI-3, SEC-14).
    await page.evaluate(() => document.fonts.ready);
    expect(watched.consoleErrors).toEqual([]);
    expect(await watched.violations()).toEqual([]);
  });

  test(`the ${entry.name} is accessible and fits every width (A11Y-1, UI-12)`, async ({ page }) => {
    await page.goto(entry.path);
    await expectAccessible(page, entry.name);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalScroll(page, `${entry.name} at ${width}px`);
    }
  });
}

test('the brand logo is decorative (UI-5)', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator('img.brand-logo');
  await expect(logo).toHaveAttribute('alt', '');
  await expect(logo).toHaveAttribute('aria-hidden', 'true');
  expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});
