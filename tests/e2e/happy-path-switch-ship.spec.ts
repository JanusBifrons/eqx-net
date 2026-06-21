import { test, expect, type Page } from '@playwright/test';

/**
 * Happy-path regression lock for the 2026-05-13 smoke-test failure:
 * "Join and spawn in. Stay near zero zero. Switch ship. And there
 *  was nothing there."
 *
 * The path under test:
 *   1. Auto-join `galaxy-sol-prime` (auth via Playwright storageState,
 *      sector via `?galaxy=` URL param — bypasses Meta + GalaxyOverview).
 *   2. Wait for the local ship to render (sector-info-panel visible AND
 *      `ship-count` >= 1).
 *   3. Wait for the roster to populate with the current ship.
 *   4. Trigger an in-game ship swap to the SAME ship (rebind path)
 *      via the Zustand `pendingShipSwap` field — exactly the same
 *      dispatch the drawer's Galaxy tab uses when the user clicks a
 *      roster card.
 *   5. The room-swap cycle (game → connecting → game) tears down the
 *      old ColyseusGameClient and brings up a new one. The new client
 *      must re-spawn the local ship in predWorld and the mirror so
 *      `ship-count` returns to >= 1.
 *
 * Failure mode this catches:
 *   - Local-ship sprite never re-renders after the swap (the 2026-05-13
 *     "nothing there" symptom).
 *   - Stale predWorld body from the pre-swap client leaks into the new
 *     client and `tryInitPredWorld` exits early.
 *   - Phase transition stuck on `connecting` (GameSurface never
 *     remounts).
 *
 * This test deliberately swaps to the SAME ship (rather than a
 * different one) so we don't need to pre-seed a multi-ship roster.
 * The rebind code path is structurally identical to a fresh-spawn
 * different-ship swap from the renderer/predWorld perspective — both
 * leave the old room and join a new one with `joinOptions.shipId`.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForLocalShip(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect(page.locator('[data-testid="sector-info-panel"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

interface RosterEntry { shipId: string; sectorKey: string }
interface UIStoreState {
  shipRoster: RosterEntry[];
  phase: string;
  playerId: string | null;
  setPendingShipSwap: (req: { shipId: string; sectorKey: string } | null) => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerTab: (tab: string) => void;
  setShipRoster: (ships: RosterEntry[]) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => UIStoreState };
}

test('switch-ship dispatch keeps the local ship rendered', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  // Step 1: auto-join galaxy-sol-prime via URL escape hatch.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Step 2: wait for first spawn — local ship visible.
  await waitForLocalShip(page);

  // Step 3: populate the roster. In production the ShipRosterPanel
  // fetches `/dev/player-ships?playerId=...` when the drawer Galaxy
  // tab mounts. In this test we mimic that fetch directly so the test
  // doesn't depend on the drawer UI (which has its own tests). The
  // server-side roster row was written when we spawned in step 2.
  const playerId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().playerId;
  });
  expect(playerId, 'playerId should be set after welcome').toBeTruthy();

  const fetchedRoster = await page.evaluate(async (pid) => {
    const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid!)}`);
    if (!res.ok) throw new Error(`roster fetch failed ${res.status}`);
    return (await res.json()) as { ships: RosterEntry[] };
  }, playerId);
  expect(fetchedRoster.ships.length, 'spawned ship should appear in roster').toBeGreaterThanOrEqual(1);

  // Mirror the panel's behaviour: push the fetched ships into the
  // Zustand store so any consumer (and the test's swap dispatch
  // below) sees them.
  await page.evaluate((ships) => {
    const win = window as unknown as StoreWindow;
    win.__eqxStore!.getState().setShipRoster(ships);
  }, fetchedRoster.ships);

  await page.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      const s = win.__eqxStore?.getState();
      return s !== undefined && s.shipRoster.length >= 1;
    },
    { timeout: 5_000 },
  );

  // Step 4: dispatch the swap. Use the first roster entry — equivalent
  // to clicking the player's only roster card.
  const swapTarget = await page.evaluate<{ shipId: string; sectorKey: string }>(() => {
    const win = window as unknown as StoreWindow;
    const s = win.__eqxStore!.getState();
    const ship = s.shipRoster[0]!;
    return { shipId: ship.shipId, sectorKey: ship.sectorKey };
  });
  expect(swapTarget.shipId).toBeTruthy();
  expect(swapTarget.sectorKey).toBeTruthy();

  await page.evaluate((req) => {
    const win = window as unknown as StoreWindow;
    win.__eqxStore!.getState().setPendingShipSwap(req);
  }, swapTarget);

  // Step 5: phase should transition game → connecting → game. Wait
  // for the round-trip to land back on game.
  await page.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      return win.__eqxStore?.getState().phase === 'connecting';
    },
    { timeout: 3_000 },
  );
  await page.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      return win.__eqxStore?.getState().phase === 'game';
    },
    { timeout: 5_000 },
  );

  // The CRITICAL assertion — after the swap, the local ship MUST
  // re-appear. This is the load-bearing check for the "nothing there"
  // smoke-test failure.
  await waitForLocalShip(page);

  // No JS runtime errors during the cycle.
  expect(errors, errors.join('\n')).toEqual([]);
});
