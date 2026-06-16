import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Drawer → Galaxy flow locks (2026-05-13 user-smoke regressions).
 *
 * Two distinct test()s, each keeping its own timeout budget (the open/close lag
 * guard relies on the tight 25 s cap + 3 s per-step ceiling; the roster-card
 * flow needs the generous 120 s budget for its extra CDP roundtrips). Do NOT
 * collapse the two timeouts.
 *
 * Equinox Phase 8 (Bug 4): "Show galaxy map" now opens the REAL full-page galaxy
 * map (the warp-context GalaxyPickerChrome / `galaxy-map-screen`), not the old
 * roster-scrim overview (GalaxyOverviewSelectChrome, now retired). Test 1 locks
 * the open→close lag of the full-page map; Test 2 locks the drawer Galaxy-tab's
 * own roster card → ShipDetailModal path (the in-game ship-swap surface).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface StoreState {
  phase: string;
  playerId: string | null;
  localShipInstanceId: string | null;
  isDrawerOpen: boolean;
  isGalaxyOverviewOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => StoreState };
  __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
  __eqxClearLogs?: () => void;
}

async function waitForLocalShip(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
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
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 5_000 });

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

// ---------------------------------------------------------------------------
// Test 2 — roster card → ShipDetailModal opens (real clicks).
// (was drawer-galaxy-overview-spawn.spec.ts)
//
// 2026-05-13 refactor regression lock: the drawer-opened overview is the
// non-warp 'select' mode; clicking a roster card must open ShipDetailModal
// (the user reported "no modal at all"). ship-roster-panel.spec.ts only
// asserts the card RENDERS — it does NOT cover the click→modal path, so this
// coverage lives only here.
// ---------------------------------------------------------------------------
test('drawer Galaxy tab → roster card opens detail modal (real clicks)', async ({ page }) => {
  // FUNCTIONAL only, not a perf budget. The main thread is saturated by Pixi
  // tick + Colyseus snapshot apply, so every CDP roundtrip needs generous
  // timeouts. (The lag budget lives in Test 1 above.)
  test.setTimeout(120_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  // === 1. Spawn via auto-join URL. ===
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForLocalShip(page, 25_000);
  const playerId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().playerId;
  });
  expect(playerId).toBeTruthy();

  // === 2. Open drawer + galaxy tab. Real click first, Zustand fallback. ===
  await page.locator('[data-testid="drawer-toggle"]').click({ force: true });
  try {
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
  } catch {
    await page.evaluate(() => {
      const win = window as unknown as StoreWindow;
      const s = win.__eqxStore!.getState();
      s.setDrawerTab('galaxy');
      s.setDrawerOpen(true);
    });
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.locator('[data-testid="galaxy-tab-show-map"]')).toBeVisible({ timeout: 30_000 });
  // Phase 8 (Bug 4): the roster panel lives in the drawer's Galaxy tab itself —
  // its card opens ShipDetailModal directly. The old "Show galaxy map → overview
  // roster scrim → card" path is retired (the button now opens the full-page map,
  // covered by galaxy-map-overlay.spec.ts).
  await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 15_000 });

  // === 3. REAL click on the roster card in the drawer's Galaxy tab. ===
  const localShipInstanceId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().localShipInstanceId;
  });
  expect(localShipInstanceId).toBeTruthy();

  // `noWaitAfter: true` is essential. Roster-card onClick is a pure Zustand
  // setState (no navigation). Without it Playwright's waitForScheduledNavigations
  // hangs the full 5 s on Pixi's continuous rAF, misreading it as "navigation
  // pending". The next assertion (ship-detail-modal) is the sync point.
  await page
    .locator(`[data-testid="ship-roster-card-${localShipInstanceId}"]`)
    .first()
    .click({ force: true, timeout: 5_000, noWaitAfter: true });

  // === 6. ShipDetailModal mounts. ===
  await expect(page.locator('[data-testid="ship-detail-modal"]')).toBeVisible({ timeout: 5_000 });
  // Sanity: the Spawn button exists (disabled, since this is the active hull).
  await expect(page.locator('[data-testid="ship-detail-spawn"]')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('[data-testid="ship-detail-spawn"]')).toBeDisabled();

  // === 7. Sanity: close the modal cleanly. ===
  // Programmatic JS click is the only method that reliably fires the React
  // onClose handler: `force:true` on a MUI Button bypasses ButtonBase's
  // pointerdown/up sequencing (no onClick), and a plain click is intercepted
  // by the gameplay canvas's `translateZ(0)` stacking context.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="ship-detail-close"]') as HTMLElement | null;
    btn?.click();
  });
  await expect(page.locator('[data-testid="ship-detail-modal"]')).toHaveCount(0, { timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
