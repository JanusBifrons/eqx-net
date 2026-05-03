import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 0 baseline: one Chromium project, one trivial boot test.
 * Later phases add multi-tab scenarios driven against a locally-spawned
 * server (see tests/e2e/).
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: process.env.CI ? 'github' : 'list',
  // Mints a real JWT for a deterministic test user before any test runs.
  // See `tests/e2e/global-setup.ts` for details — this is what makes the auth
  // gate transparent to specs without bypass logic in App.tsx.
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    headless: !process.env['PWHEADED'],
    // Pre-loaded localStorage with the auth token from globalSetup. Applied to
    // every browser context, including those created via `browser.newContext()`.
    storageState: 'tests/e2e/.auth/storage-state.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.CI_SKIP_WEBSERVER
    ? undefined
    : [
        {
          command: 'pnpm dev:server',
          port: 2567,
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: 'pnpm dev:client',
          port: 5173,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
