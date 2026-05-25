import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Manual-only perf-baseline-capture config (plan: perf-floor, Phase 2).
 *
 * The `tests/perf/` specs measure runtime perf metrics on the ambient
 * load scenario (`?galaxy=sol-prime`) and the deterministic 25-drone
 * lockstep room (`?room=feel-test-25`). They are NOT in default CI:
 * the captures take 30 s+ per arm, produce on-disk JSON, and inform
 * Phase 4 hotspot triage / Phase 5 budget locks.
 *
 * Run a baseline capture:
 *   pnpm e2e:perf
 *
 * Per-arm runtime: 30 s game-time (5 s warmup + 25 s measure) + boot.
 * Each spec runs the desktop arm + a CDP-throttled "mobile-shaped" arm
 * in the same browser context (see perf-baseline.spec.ts).
 *
 * Output: `diag/perf-baseline/<scenario>-<arm>.json` per (scenario, arm).
 *
 * Inherits baseConfig's globalSetup (JWT mint), webServer pair, baseURL,
 * headless, storageState. Per-test timeout is bumped (the 25 s measure
 * window + boot is at the edge of the 30 s default).
 */
export default defineConfig({
  ...baseConfig,
  testDir: './tests/perf',
  // Per-test timeout: 30 s boot (mobile-shaped is CDP 4×) + 60 s warp
  // curtain + 5 s warmup + 25 s measure + slack. The 25 s measure is
  // the load-bearing game-time window; everything else is
  // infrastructural cost the throttled arm pays.
  timeout: 150_000,
  // .test.ts under tests/perf/ are vitest unit locks (perfCapture.test.ts,
  // perfBudget.test.ts in Phase 5). Playwright must only match the
  // Playwright spec files (`*.spec.ts`) so vitest's expect+matchers
  // don't get pulled into the Playwright process (`@vitest/expect`
  // throws `Cannot redefine property: Symbol($$jest-matchers-object)`).
  testMatch: '**/*.spec.ts',
  projects: [
    {
      name: 'perf',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
