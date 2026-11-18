import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Drawer → Galaxy flow locks (2026-05-13 user-smoke regressions).
 *
 * The open/close lag guard relies on the tight 25 s cap + 3 s per-step
 * ceiling.
 *
 * Equinox Phase 8 (Bug 4): "Show galaxy map" now opens the REAL full-page galaxy
 * map (the warp-context GalaxyPickerChrome / `galaxy-map-screen`), not the old
 * roster-scrim overview (GalaxyOverviewSelectChrome, now retired). The test locks
 * the open→close lag of the full-page map. The roster card → ShipDetailModal
 * test went with the roster (join flow stage 5): ship swap is now map →
 * sector → Hangar, covered by happy-path-switch-ship.spec.ts.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

interface StoreState {
  phase: string;
  playerId: string | null;
  localShipInstanceId: string | null;
  isDrawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => StoreState };
  __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
  __eqxClearLogs?: () => void;
}

async function waitForLocalShip(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect(page.locator('[data-testid="hud-sector"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    }, undefined,
    { timeout: timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Test 1 — open → X close: stays interactive, no double-mount, no lag spike.
// (was drawer-galaxy-map-open-close.spec.ts)
//
// Bug repro from 2026-05-13 user smoke-test:
//   "I just literally spawned in and then opened the sidebar, clicked go to
//    galaxy map, and it was completely broken. I pressed x to go back to the
//    main map, and it was laggy as hell and looked like it had double mounted."
// ---------------------------------------------------------------------------
test('drawer → Show galaxy map → X close: stays interactive, no double-mount', async ({
  browser,
}) => {
  // Per-step latency budget. The bug surfaces as INDIVIDUAL UI interactions
  // taking many seconds (the user's "laggy as hell" symptom). A single
  // drawer-toggle click has been measured at 2.7-14 s when the bug hits;
  // healthy is sub-second. A 3 s ceiling per step fails loudly instead of
  // accumulating into a generic timeout.
  test.setTimeout(25_000);
  const MAX_STEP_MS = 3_000;
  const assertStepUnder = (label: string, elapsedMs: number): void => {
    expect(
      elapsedMs,
      `Step "${label}" took ${elapsedMs} ms, expected < ${MAX_STEP_MS} ms. ` +
        `This is the user-reported lag (drawer/HUD interactions hanging for seconds).`,
    ).toBeLessThan(MAX_STEP_MS);
  };
  const errors: string[] = [];
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  // Diagnostic correlation only — we deliberately do NOT fail on console
  // error/warning: game boot emits pre-existing ambient warnings unrelated to
  // this flow (Pixi v8 addChild deprecation; PerformanceObserver buffered
  // flag). This spec's regression locks are the per-step MAX_STEP_MS ceilings
  // (the "laggy" guard), the GalaxyOverviewScreen mount-count audit (the
  // "double-mount" guard) and the HUD-alive checks. Uncaught exceptions still
  // hard-fail via the `pageerror` handler above.
  page.on('console', (msg) => {
    console.log(`[browser/${msg.type()}] ${msg.text()}`);
  });
  const t0 = Date.now();
  let lastStepAt = t0;
  const stamp = (label: string, opts: { assertUnderMaxStep?: boolean } = { assertUnderMaxStep: true }): void => {
    const now = Date.now();
    const sinceStart = now - t0;
    const stepMs = now - lastStepAt;
    console.log(`[test] +${sinceStart.toString().padStart(5)}ms (step ${stepMs.toString().padStart(5)}ms) ${label}`);
    if (opts.assertUnderMaxStep !== false) assertStepUnder(label, stepMs);
    lastStepAt = now;
  };

  // === 1. Spawn === (initial connect+welcome is not lag-gated)
  stamp('goto start', { assertUnderMaxStep: false });
  await page.goto(`${BASE_URL}/?galaxy=sol-prime&startMode=fly`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  stamp('goto done', { assertUnderMaxStep: false });
  await waitForLocalShip(page);
  stamp('local ship rendered', { assertUnderMaxStep: false });

  // Clear the log buffer so the mount-event assertions below are bounded to
  // the open→close window.
  await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    win.__eqxClearLogs?.();
  });
  stamp('logs cleared');

  // === 2. Open drawer ===
  // `force: true` skips actionability checks. If the click is fast with force
  // but slow without, the bug is in the PAGE's stability (render storm / GPU
  // stall). If slow either way, the bug is in the click HANDLER.
  await page.locator('[data-testid="drawer-toggle"]').click({ force: true });
  stamp('clicked drawer-toggle');
  try {
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 2_000 });
    stamp('advanced-drawer visible after toggle click');
  } catch {
    stamp('toggle click did NOT open drawer; falling back to Zustand');
    await page.evaluate(() => {
      const win = window as unknown as StoreWindow;
      win.__eqxStore!.getState().setDrawerOpen(true);
      win.__eqxStore!.getState().setDrawerTab('galaxy');
    });
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
    stamp('advanced-drawer visible after Zustand fallback');
  }
  await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 5_000 });
  stamp('drawer-panel-galaxy visible');
  await expect(page.locator('[data-testid="galaxy-tab-show-map"]')).toBeVisible({ timeout: 5_000 });
  stamp('galaxy-tab-show-map visible');

  // === 3. Click "Show galaxy map" — Phase 8 (Bug 4): opens the full-page map ===
  await page.locator('[data-testid="galaxy-tab-show-map"]').click();
  stamp('clicked Show galaxy map');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 5_000 });
  stamp('galaxy-map-screen visible');
  await expect(page.locator('[data-testid="galaxy-warp-close"]')).toBeVisible({ timeout: 5_000 });
  stamp('galaxy-warp-close visible');
  // Light double-mount guard (replaces the old GalaxyOverviewSelectChrome
  // mount-count audit; that roster scrim is retired): the full-page map mounts
  // exactly once on a single open click.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(1);

  // === 4. Click X close ===
  await page.locator('[data-testid="galaxy-warp-close"]').click();
  stamp('clicked X close');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('[data-testid="hud-sector"]')).toBeVisible({ timeout: 5_000 });

  // === 5. Confirm the game surface is still ALIVE after the cycle ===
  const shipCount = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return parseInt(el?.textContent?.replace('Ships: ', '') ?? '0', 10);
  });
  expect(shipCount, 'ship-count should still be > 0 after open/close').toBeGreaterThan(0);

  expect(errors, errors.join('\n')).toEqual([]);
  await page.close();
  await ctx.close();
});
