import { defineConfig } from '@playwright/test';
import { baseURL, prepare } from './tests/e2e/environment';

/**
 * Browser tests (TEST-6) against the built server and client
 * (`npm run test:e2e` builds both first), started on a fresh data directory
 * (`tests/e2e/environment.ts`). The suite shares one server, so it
 * runs with one worker. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a
 * preinstalled Chromium when the one `npx playwright install --with-deps
 * chromium` installs is not available.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

// The config is also loaded in each worker: prepare the data directory only once, in the runner.
let serverEnv: Record<string, string> = JSON.parse(process.env.AGT_TRIVIA_E2E_SERVER_ENV ?? 'null');
if (!serverEnv) {
  serverEnv = prepare(process.env);
  process.env.AGT_TRIVIA_E2E_SERVER_ENV = JSON.stringify(serverEnv);
}

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
    env: serverEnv,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
