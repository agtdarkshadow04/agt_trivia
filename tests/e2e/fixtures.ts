import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Shared checks of the browser tests (TEST-6). */

/** Collects CSP violations and console errors from the first script on every page. */
export async function watchPage(page: Page) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
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
