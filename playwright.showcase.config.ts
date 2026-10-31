import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Living World showcase recordings (plan peppy-jumping-pinwheel) — NOT a test
 * gate. Each phase ships a scripted Playwright run that RECORDS a short video
 * of the feature in the real game, for the PR + the showcase artifact.
 *
 *   pnpm exec playwright test --config playwright.showcase.config.ts
 *
 * Videos land in `test-results/` (Playwright's default); the spec copies the
 * finished file to `diag/showcase/<phase>/`.
 */
export default defineConfig({
  ...baseConfig,
  testDir: './tests/showcase',
  testMatch: '**/*.spec.ts',
  timeout: 300_000,
  retries: 0,
  // Server boot (21 galaxy rooms) + a cold Vite compile can exceed the base 30 s
  // on a loaded box — infrastructural, so widen ONLY the startup window here.
  webServer: (Array.isArray(baseConfig.webServer) ? baseConfig.webServer : baseConfig.webServer ? [baseConfig.webServer] : [])
    .map((w) => ({ ...w, timeout: 240_000 })),
  use: {
    ...baseConfig.use,
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'showcase',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
});
