import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 0 baseline: one Chromium project, one trivial boot test.
 * Later phases add multi-tab scenarios driven against a locally-spawned
 * server (see tests/e2e/).
 *
 * ── E2E policy (2026-05-11) ─────────────────────────────────────────────
 * 1. **30-second per-test cap, non-negotiable**: any test that takes longer
 *    fails immediately. Long timeouts are bugs, not features. Use
 *    `--reporter=line` for diagnostic runs so failing tests surface fast.
 * 2. **Zero local retries**: a test that flakes is broken — debugging
 *    re-runs costs more time than tightening the spec. CI can override
 *    via `PLAYWRIGHT_RETRIES=1` if a known-flaky environment demands it.
 * 3. **Tightly-controlled scenarios only**: no random ship kinds, no
 *    random sectors, no random inputs. Specs that need a deterministic
 *    environment must use `?room=test-sector` (testMode=true, no drones)
 *    rather than `?room=sector` (random-kind drone wave) or a galaxy
 *    sector (persistent state from prior runs). Specs that need drones
 *    must spawn them via a dedicated test room with explicit `droneCount`
 *    + `pickDroneKind` overrides through `JoinOptions`.
 * 4. **Playwright spawns dev:server:nowatch**, not `dev:server`. The
 *    `tsx watch` file watcher inflates CPU on Windows (chokidar polling)
 *    and turns idle servers into 700%-CPU runaways across long sessions —
 *    the unwatched variant is identical for test purposes since Playwright
 *    starts a fresh process per suite.
 * ───────────────────────────────────────────────────────────────────────
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  /** Hard ceiling on a full suite. Stops a wedged spec series from eating
   *  an unbounded wall-clock window. 6 min covers ~12 sequential 30 s
   *  failures (the practical worst case for a focused-spec run) plus
   *  webServer spin-up. */
  globalTimeout: 6 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.PLAYWRIGHT_RETRIES ? Number(process.env.PLAYWRIGHT_RETRIES) : 0,
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
          // dev:server:nowatch (NOT dev:server) — bypasses tsx watch's
          // chokidar polling which on Windows climbs to ~700 % CPU after
          // a few minutes of idle time and turns a single sluggish test
          // into a multi-minute wall-clock sink. The watch reload is
          // useless for Playwright anyway since each suite spawns a
          // fresh process.
          command: 'pnpm dev:server:nowatch',
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
