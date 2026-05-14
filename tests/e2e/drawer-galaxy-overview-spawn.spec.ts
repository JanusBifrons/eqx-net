import { test, expect, type Page } from '@playwright/test';

/**
 * Drawer → Galaxy tab → "Show galaxy map" → roster card → modal opens.
 *
 * 2026-05-13 refactor regression lock. The drawer-opened galaxy
 * overview was changed to a non-warp 'select' mode (the galaxy is
 * visual context only; the roster panel is the only tap surface).
 * The user reported the previous build's flow as broken: clicking a
 * roster card produced no modal at all.
 *
 * Scope: single-spawn flow. Verifies the user-reported bug surface
 * (roster card click → ShipDetailModal opens) and the refactor's
 * contract (overview mounts as `galaxy-overview-select`, NOT
 * `galaxy-overview-warp`).
 *
 * Why we don't seed a second ship: the dual-goto setup
 * (spawn A → goto-with-newShip=1 → spawn B) eats ~50 s of the test
 * budget on Colyseus connect cycles, which leaves no headroom for
 * the UI interactions and causes the page to get torn down mid-test
 * ("Target page, context or browser has been closed"). The
 * Spawn-button-clickable-then-cycle assertion is already covered by
 * the programmatic `happy-path-switch-ship.spec.ts`. This spec's
 * job is the UI contract: real clicks reach the modal.
 *
 * Real clicks (the broken-flow steps the user named):
 *   - "Show galaxy map" button in the drawer.
 *   - The roster card inside the overview.
 *
 * Drawer toggle goes through Zustand to dodge the MUI Drawer mount
 * timing wall (same approach as drawer-galaxy-map-open-close.spec.ts
 * uses as a fallback).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface StoreState {
  playerId: string | null;
  phase: string;
  localShipInstanceId: string | null;
  setDrawerOpen: (v: boolean) => void;
  setDrawerTab: (id: string) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => StoreState };
}

async function waitForLocalShip(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

test('drawer → Show galaxy map → roster card opens detail modal (real clicks)', async ({ page }) => {
  // This spec is FUNCTIONAL only, not a perf budget. The main thread is
  // saturated by Pixi tick + Colyseus snapshot apply, so every step
  // through Playwright's CDP roundtrip needs generous timeouts. Perf
  // measurement lives in `drawer-lag-trace.spec.ts`.
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

  // === 2. Open drawer + galaxy tab. ===
  // Real click first, Zustand fallback if the MUI Drawer's mount
  // transition is slow (well-known Pixi×MUI×Playwright timing wall).
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
  // The Galaxy tab is the default-selected tab — its content (incl. the
  // ShipRosterPanel + "Show galaxy map" button) renders inside the
  // drawer's `drawer-panel-galaxy` host. Generous timeout: the MUI Slide
  // transition mounts children lazily, and the main thread is contended
  // by Pixi tick.
  await expect(page.locator('[data-testid="galaxy-tab-show-map"]')).toBeVisible({ timeout: 30_000 });

  // === 3. REAL click: "Show galaxy map". ===
  await page
    .locator('[data-testid="galaxy-tab-show-map"]')
    .click({ force: true, timeout: 15_000 });

  // === 4. Refactor contract: overview opens in 'select' mode, NOT warp. ===
  await expect(page.locator('[data-testid="galaxy-overview-select"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="galaxy-overview-warp"]')).toHaveCount(0);

  // === 5. REAL click on the roster card inside the overview. ===
  // The local ship is the only ship in the roster (single-spawn flow).
  // We just want to verify the modal opens — the Spawn button will be
  // disabled because it's the currently-piloted hull (`isMyPilotedShip`),
  // but the modal itself MUST render. The user's reported bug was "no
  // modal at all" — this asserts the click reaches the modal mount.
  const localShipInstanceId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().localShipInstanceId;
  });
  expect(localShipInstanceId).toBeTruthy();

  // `noWaitAfter: true` is essential here. Roster-card onClick is a pure
  // Zustand setState (no history.pushState, no location change, no
  // navigation). Playwright's default `waitForScheduledNavigations` then
  // hangs the full 5 s on Pixi's continuous rAF, which it misreads as
  // "navigation pending". The next assertion (`ship-detail-modal`
  // toBeVisible) is the correct synchronisation point.
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
  // `noWaitAfter: true` for the same reason as step 5 — the close button
  // is a pure setState (`setOpenShipId(null)`), not a navigation. Without
  // this, Playwright hangs waiting for the imaginary "scheduled
  // navigation" to land while Pixi's continuous rAF keeps the page
  // looking busy.
  await page
    .locator('[data-testid="ship-detail-close"]')
    .click({ force: true, timeout: 3_000, noWaitAfter: true });
  await expect(page.locator('[data-testid="ship-detail-modal"]')).toHaveCount(0, { timeout: 10_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
