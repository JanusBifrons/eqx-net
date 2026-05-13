import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Bug repro from 2026-05-13 user smoke-test:
 *   "I just literally spawned in and then opened the sidebar, clicked
 *    go to galaxy map, and it was completely broken. I pressed x to go
 *    back to the main map, and it was laggy as hell and looked like it
 *    had double mounted."
 *
 * The exact flow under test:
 *   1. Auto-join galaxy-sol-prime (`?galaxy=sol-prime`).
 *   2. Wait for spawn (ship-stats-card + ship-count >= 1).
 *   3. Open drawer via toggle (the user said "sidebar").
 *   4. Galaxy tab is default-selected; click "Show galaxy map".
 *   5. GalaxyOverviewScreen mounts in `warp` mode.
 *   6. Click the X close button.
 *   7. Verify the game surface is still functional (no lag spike,
 *      no double-mount, ship-stats-card still visible).
 *
 * We assert on three load-bearing surfaces:
 *   - `galaxy-overview-close` exists when the map is open
 *   - `ship-stats-card` re-visible after close (the surface that
 *     was supposed to come back when X is pressed)
 *   - `component_mount` event log has exactly ONE additional
 *     `GalaxyOverviewScreen` mount between open and close in
 *     production builds (in dev StrictMode the count is 2; we
 *     account for that). MORE than that is the "double-mounted"
 *     symptom the user described.
 *
 * If this test fails on `main`, we have proven the user-reported
 * regression in CI — and the fix is no longer "smoke-test and pray".
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface StoreState {
  phase: string;
  playerId: string | null;
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

test('drawer → Show galaxy map → X close: stays interactive, no double-mount', async ({
  browser,
}) => {
  // Per-step latency budget. The bug surfaces as INDIVIDUAL UI
  // interactions taking many seconds (the user's "laggy as hell"
  // symptom). When the bug hits, a single click on drawer-toggle has
  // been measured at 2.7-14 s. Healthy behaviour is sub-second. We
  // assert a 3 s ceiling per step so a single laggy interaction fails
  // the test loudly instead of accumulating into a generic timeout.
  //
  // The bug is intermittent (captured in repro logs as 28 s total
  // wall-clock to reach the show-map button on one run; 12 s on
  // another). Console warnings hint at the cause: `GPU stall due to
  // ReadPixels (High)` from Pixi v8 / WebGL — synchronous GPU work
  // blocking the main thread, starving React + Playwright auto-wait.
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
  // Capture ALL console output so we can correlate browser-side
  // activity with the test's timing stamps.
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') errors.push(`CONSOLE-${t.toUpperCase()}: ${msg.text()}`);
    console.log(`[browser/${t}] ${msg.text()}`);
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

  // === 1. Spawn ===
  // The first three steps (goto, ship-render) are intentionally NOT
  // gated by `assertStepUnder` because the initial connect + welcome
  // legitimately takes a couple of seconds on first boot.
  stamp('goto start', { assertUnderMaxStep: false });
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  stamp('goto done', { assertUnderMaxStep: false });
  await waitForLocalShip(page);
  stamp('local ship rendered', { assertUnderMaxStep: false });

  // Clear the log buffer so the mount-event assertions below are
  // bounded to the open→close window.
  await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    win.__eqxClearLogs?.();
  });
  stamp('logs cleared');

  // === 2. Open drawer ===
  // `force: true` skips Playwright's actionability checks (visible /
  // enabled / stable). If the click is fast with force but slow
  // without, the bug is in the PAGE's stability (continuous reflow
  // from a render storm or GPU stalls). If it's slow either way, the
  // bug is in the click HANDLER (React render storm).
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

  // === 3. Click "Show galaxy map" ===
  await page.locator('[data-testid="galaxy-tab-show-map"]').click();
  stamp('clicked Show galaxy map');
  await expect(page.locator('[data-testid="galaxy-overview-close"]')).toBeVisible({ timeout: 5_000 });
  stamp('galaxy-overview-close visible');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 5_000 });
  stamp('galaxy-map-screen visible');

  // === 4. Click X close ===
  await page.locator('[data-testid="galaxy-overview-close"]').click();
  stamp('clicked X close');
  // After close, the overview should disappear and the game HUD
  // should still be alive.
  await expect(page.locator('[data-testid="galaxy-overview-close"]')).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 5_000 });

  // === 5. Mount-count audit (catches the "double-mounted" symptom) ===
  // Count `component_mount` events for GalaxyOverviewScreen between
  // the log clear (post-spawn) and now. Acceptable counts:
  //   - production: 1 (open) + 1 (close cycle? — should be 0 close mount)
  //   - dev StrictMode: 2 (open, with strict-mode pair) + 0 close mount
  // If the count exceeds 2, the overlay double-mounted on a single
  // open click — the user's reported symptom.
  const mountCount = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    const logs = win.__eqxLogs ?? [];
    return logs.filter(
      (e) => e.tag === 'component_mount' && e.data['name'] === 'GalaxyOverviewScreen',
    ).length;
  });
  expect(
    mountCount,
    `GalaxyOverviewScreen mounted ${mountCount} times in one open/close cycle. ` +
      `Expected ≤ 2 (StrictMode doubles mount on first open; close should not mount). ` +
      `>2 = the user-reported double-mount regression.`,
  ).toBeLessThanOrEqual(2);

  // === 6. Confirm the game surface is still ALIVE after the cycle ===
  // ship-stats-card visibility above already checks the HUD is back;
  // verify ship-count is still > 0 (mirror not corrupted by the cycle).
  const shipCount = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return parseInt(el?.textContent?.replace('Ships: ', '') ?? '0', 10);
  });
  expect(shipCount, 'ship-count should still be > 0 after open/close').toBeGreaterThan(0);

  expect(errors, errors.join('\n')).toEqual([]);
  await page.close();
  await ctx.close();
});
