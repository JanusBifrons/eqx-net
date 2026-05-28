import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Manual-only mobile-perf gate config.
 *
 * Heap + DOM + RAF jitter gate that runs against either a real
 * Android device / AVD via `playwright._android` (when
 * `MOBILE_PERF_MODE=force-device` or `auto` and `adb devices`
 * sees one) OR a CPU-throttled desktop Chromium fallback (the
 * default in this repo's remote-container environment).
 *
 * Run:
 *
 *   pnpm e2e:mobile-perf
 *
 * Modes via env:
 *   - `MOBILE_PERF_MODE=force-fallback` (default) — desktop CPU
 *     throttle ×4. Same pattern as `tests/perf/perf-baseline.spec.ts`.
 *   - `MOBILE_PERF_MODE=force-device` — real Android only; fails
 *     loudly if no device is present.
 *   - `MOBILE_PERF_MODE=auto` — try device, fall back if absent.
 *
 * Per-test timeout: 60 s (NOT 180 s — `testTimeScale=10` collapses
 * the 30 s game-time stress phase to ~3 s wall-clock; total spec
 * runtime ~35-40 s in fallback). If a real Android device's cold
 * boot needs more, override via `MOBILE_PERF_TIMEOUT_MS`.
 *
 * Inherits from baseConfig: globalSetup (JWT mint), webServer pair,
 * baseURL, headless. Overrides testDir + projects. The mobile-perf
 * tests live OUTSIDE `tests/e2e/` so they are already structurally
 * excluded from `pnpm e2e` by base config's `testDir: './tests/e2e'`.
 *
 * NOT in CI — local-only by design (the user's CI runs ubuntu-latest
 * without KVM / Android emulator support; the device path needs
 * `adb` on PATH which the container lacks).
 */
const TIMEOUT_MS = process.env['MOBILE_PERF_TIMEOUT_MS']
  ? Number(process.env['MOBILE_PERF_TIMEOUT_MS'])
  : 60_000;

export default defineConfig({
  ...baseConfig,
  testDir: './tests/mobile-perf',
  // 60 s default — see header. The injected-leak regression spec
  // shares this budget (it runs the same boot + stress flow).
  timeout: TIMEOUT_MS,
  // .test.ts under tests/mobile-perf/ are vitest unit locks
  // (mobilePerfBudget.test.ts). Playwright only matches the
  // Playwright spec files (`*.spec.ts`) so vitest's matchers don't
  // get pulled into Playwright's process.
  testMatch: '**/*.spec.ts',
  // Single project — no fan-out. The device-vs-fallback choice is
  // runtime via `MOBILE_PERF_MODE`, not config-time.
  projects: [
    {
      name: 'mobile-perf',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
