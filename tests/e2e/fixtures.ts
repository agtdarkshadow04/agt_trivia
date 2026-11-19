import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Shared names and checks of the browser tests (TEST-6). */

/** The signed-in Admin state the setup project saves (`setup.spec.ts`). */
export const adminState = 'tests/e2e/.auth/admin.json';
export const admin = { username: 'keeper', password: 'Admin-Password-1!' };

/** Collects CSP violations and console errors from the first script on every page. */
export async function watchPage(page: Page) {
  const consoleErrors: string[] = [];
  // A 401 from the session check of a signed-out page is expected; Chromium logs it as a failed load.
  page.on('console', (message) => { if (message.type() === 'error' && !/status of 401/.test(message.text())) consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const violations: { directive: string; blocked: string }[] = [];
    (window as unknown as { violations: typeof violations }).violations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  return {
    consoleErrors,
    violations: () => page.evaluate(() => (window as unknown as { violations: { directive: string; blocked: string }[] }).violations.slice()),
  };
}

/** No WCAG 2.2 AA violation on the page (A11Y-1, A11Y-3, A11Y-5). */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`), label).toEqual([]);
}

/** No horizontal page scroll (UI-12). */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

/** Stores browser preferences before the app reads them (FE-3). */
export async function preferences(page: Page, values: Record<string, unknown>) {
  await page.addInitScript((stored) => localStorage.setItem('agt_trivia_settings', JSON.stringify(stored)), values);
}

/** Opens `opener` from the keyboard, checks that Tab stays inside the dialog, Escape closes it and focus returns (A11Y-2). */
export async function expectDialogBehaviour(page: Page, opener: ReturnType<Page['getByRole']>, name: string | RegExp) {
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${step + 1} stays in the dialog`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
}
