import { defineConfig } from '@playwright/test';

/**
 * Browser tests (TEST-6) against the built server and client
 * (`npm run test:e2e` builds both first). The suite shares one server, so it
 * runs with one worker. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a
 * preinstalled Chromium when the one `npx playwright install --with-deps
 * chromium` installs is not available.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const port = 8082;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node dist-server/index.mjs',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', AGT_TRIVIA_STATIC_DIR: 'dist' },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
