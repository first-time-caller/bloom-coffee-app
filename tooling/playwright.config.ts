import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 4173);
const CI = !!process.env.CI;

// Locally the preinstalled Chromium in $PLAYWRIGHT_BROWSERS_PATH is used (never `playwright install` here);
// in GitHub Actions the workflow runs `npx playwright install --with-deps chromium`. Both resolve through the same config.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './lib/global-setup.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1, // timing/memory budgets are only meaningful without CPU contention
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 7_000 },
  // JSON goes to $PLAYWRIGHT_JSON_OUTPUT_NAME (set per gate by scripts/run-gate.mjs); scripts/run-gate.mjs reads it for the known-bug summary.
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json']] : [['list'], ['json']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false } }],
  webServer: {
    command: `node scripts/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !CI,
    timeout: 20_000
  }
});
