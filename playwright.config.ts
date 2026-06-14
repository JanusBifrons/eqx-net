import { defineConfig, devices } from '@playwright/test';

/**
 * ── E2E policy (2026-05-11; tier taxonomy 2026-05-20) ───────────────────
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
 * 5. **Four-tier taxonomy** (`docs/architecture/e2e-framework.md`):
 *    - `@smoke`   (14 specs) — fast deterministic critical-path locks.
 *                  CI step 1; `pnpm e2e:smoke`.
 *    - `@feature` (30 specs) — per-surface exhaustive locks.
 *                  CI step 2; `pnpm e2e` runs `@smoke` THEN `@feature`
 *                  (smoke-first fail-fast).
 *    - `@gate`    (1 spec)   — machine-insensitive baseline-vs-HEAD gate
 *                  (`netcode-health.spec.ts`). Standalone `pnpm e2e:gate`
 *                  runs a self-skipping no-op; the gate proper is driven
 *                  by `pnpm e2e:netgate` (sets `NETGATE_ARMS`).
 *    - `@diag`    (6 specs)  — capture-only probes, MANUAL ONLY, live
 *                  under `tests/diag/` and are excluded from `testDir`
 *                  here so they never bloat CI.
 *    Tier membership is in this file (testMatch lists). The doc is the
 *    decision artefact; this config is the runtime enforcement.
 * ───────────────────────────────────────────────────────────────────────
 */

const SMOKE_SPECS: string[] = [
  '**/boot.spec.ts',
  '**/damage-number-lifetime.spec.ts',
  '**/happy-path-switch-ship.spec.ts',
  '**/join-warp-screen.spec.ts',
  '**/layout-slots.spec.ts',
  '**/mobile-joystick-ship-swap.spec.ts',
  '**/persistence-kill.spec.ts',
  '**/scenarios/combat-lifecycle.spec.ts',
  '**/sector-alpha.spec.ts',
  '**/shield-hud.spec.ts',
  '**/ship-selection.spec.ts',
  '**/spawn-handshake.spec.ts',
  '**/spawn-select-flow.spec.ts',
  '**/weapon-switching.spec.ts',
];

// NOTE: fixed-window measurement specs (heap/alloc/bandwidth/worker-ab/diag-mode/
// mobile-perf-probe4 + the WebRTC-vs-WS recv-gap gate) were relocated to
// `tests/perf/` (run via `pnpm e2e:perf`, playwright.perf.config.ts) by the
// test-coverage determinism refactor (2026-06-03) — they hold a wall-clock
// window to gather a number and don't belong in the per-PR e2e suite. One-off
// investigation/bisect/repro captures were deleted. See
// docs/refactors/test-coverage-audit.md.
const FEATURE_SPECS: string[] = [
  '**/asteroid-shape.spec.ts',
  '**/auto-fire.spec.ts',
  '**/avatar-menu-logout.spec.ts',
  '**/boost-facing.spec.ts',
  '**/combat/*.spec.ts',
  '**/missile-frigate-homing.spec.ts',
  '**/collision-events.spec.ts',
  '**/configurable-arrival.spec.ts',
  '**/energy-bar.spec.ts',
  '**/entity-inspect.spec.ts',
  '**/respawn-cascade-input-routing.spec.ts',
  '**/drawer-galaxy.spec.ts',
  '**/drone-destruction.spec.ts',
  '**/drone-laser-smoothness.spec.ts',
  '**/engine-particles-probe.spec.ts',
  '**/engine-particles-flight.spec.ts',
  '**/engine-particles-demo.spec.ts',
  '**/feel-test-lockstep.spec.ts',
  '**/feel-tuning.spec.ts',
  '**/galaxy-map-overlay.spec.ts',
  '**/galaxy-map-pan-zoom.spec.ts',
  '**/galaxy-polish.spec.ts',
  '**/halo-radar.spec.ts',
  '**/input-throttle-drift.spec.ts',
  '**/laser-smoothness.spec.ts',
  '**/laser-falloff-probe.spec.ts',
  '**/prediction-idle-bounded.spec.ts',
  '**/renderer-worker-probe.spec.ts',
  '**/robustness.spec.ts',
  '**/ship-roster-panel.spec.ts',
  '**/spiral-disconnect-reconnect.spec.ts',
  '**/swarm-jitter.spec.ts',
  '**/swarm-sleep.spec.ts',
  '**/swarm-tidi.spec.ts',
  '**/wave-attack.spec.ts',
  '**/sync-health.spec.ts',
  '**/t-ship-no-self-collision.spec.ts',
  '**/tship-collision-probe.spec.ts',
  '**/structure-ram-blocked.spec.ts',
  '**/ramming-probe-armpit.spec.ts',
  '**/warp-engage-cancel.spec.ts',
  '**/wreck-render-probe.spec.ts',
  '**/structure-visible-damageable.spec.ts',
  // Structures plan (speed-dial-resource-structures) — build/grid/mining/turret.
  '**/structure-build-placement.spec.ts',
  '**/structure-placement-ghost.spec.ts',
  '**/structure-grid-web.spec.ts',
  '**/structure-scenario.spec.ts',
  '**/structure-mining-beam.spec.ts',
  '**/linger/*.spec.ts',
  // Lingering-hull weapon-barrel render across the worker boundary (WS-12 / R2.32).
  '**/lingering-render.spec.ts',
  // Speed-dial UX (WS-13 / R2.6 — Build category tier + stay-open + labels).
  '**/speed-dial.spec.ts',
];

const GATE_SPECS: string[] = ['**/netcode-health.spec.ts'];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  /** Hard ceiling on a full suite. Stops a wedged spec series from eating
   *  an unbounded wall-clock window. 25 min (hostile M4, e2e-rebuild plan):
   *  the suite is ~50 specs × 30 s worst-case = ~25 min serial worst-case.
   *  The previous 6 min would abort the whole suite first on a slow CI
   *  runner — i.e. globalTimeout was *itself* the suite ceiling, masking
   *  real wall-clock health as "globalTimeout exceeded." Matches the CI
   *  `timeout-minutes` on .github/workflows/ci.yml. */
  globalTimeout: 25 * 60 * 1000,
  // Workers: 1 (cross-FILE serial). Per-test rooms via `filterBy(testId)`
  // are wired but a single shared `dev:server:nowatch` can't service
  // multiple concurrent test sessions without contention regressions
  // (pre-existing tests started failing at workers=3). True
  // parallelism needs N independent server processes (one per worker)
  // — that's a separate plumbing task. The infrastructure (per-test
  // rooms + testTimeScale) stays in for future use.
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
  // Tiered projects (see policy note 5 above). Order matters: when
  // `pnpm e2e` runs `--project=smoke --project=feature`, Playwright
  // executes them in the order listed here — smoke first, so a critical-
  // path regression fails CI in ~2 min instead of after the full suite.
  // Default `playwright test` (no --project flag) runs ALL THREE; the
  // scripts in package.json (`e2e`, `e2e:smoke`, `e2e:gate`) are the
  // canonical entry points and explicitly filter.
  projects: [
    {
      name: 'smoke',
      testMatch: SMOKE_SPECS,
      // fullyParallel intentionally OFF inside a file (within-file tests
      // run serially; their per-room state and shared-server contention
      // are not always safe). Cross-FILE parallelism still happens via
      // `workers: N` at the top level — different spec files run on
      // different workers concurrently, each with its own per-test
      // rooms via `filterBy(['testId'])`.
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'feature',
      testMatch: FEATURE_SPECS,
      // Same rationale as smoke.
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'gate',
      testMatch: GATE_SPECS,
      // gate stays serial — netcode-health is load-sensitive by design.
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
          // Wave-system E2E (wave-attack.spec.ts): boot the director-managed
          // `galaxy-wave-test` room + a fast drone spool so the wave fires in
          // seconds, not 5 min. `EQX_BOT_HOP_MS=500` collapses the per-hop
          // inter-sector flight (default 2 min) so the squad's hop-by-hop
          // traversal to the base completes in-test. Inert for other specs (the
          // wave room only acts when the base owner is present; no other spec
          // touches it). Merged onto process.env by Playwright.
          env: { EQX_E2E_WAVE: '1', EQX_BOT_SPOOL_MS: '5000', EQX_BOT_HOP_MS: '500' },
        },
        {
          command: 'pnpm dev:client',
          port: 5173,
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
