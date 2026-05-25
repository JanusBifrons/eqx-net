import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Manual-only diagnostic-spec config (e2e-rebuild Phase 2b,
 * docs/architecture/e2e-framework.md).
 *
 * The `@diag` specs (drawer-cdp-starvation-probe, offscreen-spike-probe,
 * warp-spool-perf-capture, drawer-lag-trace, drawer-keepmounted-probe,
 * modal-close-diagnostic) live under `tests/diag/` because they are
 * capture-only — they collect CDP traces, frame markers, DOM dumps for
 * offline analysis but DO NOT assert behaviour. Putting them outside the
 * default `testDir: './tests/e2e'` is how we keep them out of CI without
 * deleting them. They remain manually runnable via this config.
 *
 * Run all diag specs:
 *   pnpm e2e:diag
 *
 * Run one:
 *   pnpm e2e:diag tests/diag/warp-spool-perf-capture.spec.ts
 *
 * Inherits the main config's globalSetup (JWT mint), webServer pair,
 * baseURL, headless, storageState, and per-test timeout/retries. Only
 * testDir + projects differ.
 */
export default defineConfig({
  ...baseConfig,
  testDir: './tests/diag',
  // Single project — no tier filtering inside `tests/diag/`. Every file
  // here is a diag capture by definition (the directory IS the tier).
  projects: [
    {
      name: 'diag',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
