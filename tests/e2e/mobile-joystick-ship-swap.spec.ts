import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke-test regression lock — 2026-05-14 mobile bug:
 *   "I was playing around. Everything was working perfectly. And then
 *   I got a little jolt of lag, opened various menus, and I got a jolt
 *   of lag. And then the UI double mounted." → Two nipplejs thumbsticks
 *   visible after triggering an in-game ship swap from the drawer
 *   Galaxy tab's roster card.
 *
 * THE FLOW UNDER TEST:
 *   1. Mobile touch viewport (hasTouch:true, isMobile:true) so
 *      `isTouchDevice()` → true and `<MobileControls>` mounts.
 *   2. Spawn into `galaxy-sol-prime` via the `?galaxy=` URL escape.
 *      First joystick appears. Roster gets one ship.
 *   3. Read the spawned shipId from the Zustand singleton.
 *   4. Dispatch `pendingShipSwap` with the SAME shipId — the swap
 *      flow runs `game → connecting → game`, which unmounts and
 *      remounts GameSurface (and MobileControls inside it). This is
 *      the user's reported trigger.
 *   5. After the swap completes, assert there is EXACTLY ONE
 *      visible joystick. If two exist, the old MobileControls'
 *      cleanup failed to tear down its nipplejs DOM before the new
 *      mount created its replacement → bug repros.
 *
 * WHAT THE TEST ASSERTS:
 *   - One `[data-testid="mobile-joystick"]` zone.
 *   - One `.joystick` element (nipplejs's joystick handle DOM) globally
 *     across the page (counting in/around the zone catches both
 *     child-of-zone and sibling-of-zone leak shapes).
 *
 * REGRESSION RECIPE:
 *   - Revert the cleanup defense → test re-fails with .joystick count
 *     of 2 (or more) immediately after the swap.
 *
 * Diagnostic surfaces this test uses:
 *   - `__eqxLogs` ring (joystick_created + joystick_destroyed events
 *     added 2026-05-14 alongside this bug for future-proofing). The
 *     destroy event carries `leftoverInZone` + `leftoverSiblings`
 *     counters — non-zero values are the smoking gun for the bug.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// Force touch + mobile viewport so isTouchDevice() returns true and
// the joystick mounts at all. Without this, MobileControls is gated
// off and the test premise breaks.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 914, height: 411 }, // matches the user's diagnostic capture
});

interface RosterEntry { shipId: string; sectorKey: string }
interface UIStoreState {
  shipRoster: RosterEntry[];
  phase: string;
  playerId: string | null;
  setPendingShipSwap: (req: { shipId: string; sectorKey: string } | null) => void;
  setShipRoster: (ships: RosterEntry[]) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => UIStoreState };
  __eqxLogs?: Array<{ ts: number; tag: string; data: Record<string, unknown> }>;
}

async function waitForLocalShip(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

async function waitForJoystickMounted(page: Page, timeoutMs = 10_000): Promise<void> {
  // `.joystick` is the nipplejs joystick handle DOM. One mount creates
  // exactly one `.joystick` element inside the joystick zone.
  await expect(page.locator('.joystick').first()).toBeAttached({ timeout: timeoutMs });
}

async function countJoysticks(page: Page): Promise<{ zones: number; joysticks: number }> {
  return page.evaluate(() => ({
    zones: document.querySelectorAll('[data-testid="mobile-joystick"]').length,
    joysticks: document.querySelectorAll('.joystick').length,
  }));
}

test('in-game ship swap does NOT leave a stale joystick (two thumbsticks bug)', async ({ page }) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  // Step 1 — auto-join galaxy-sol-prime. GameSurface mounts; on a
  // touch viewport, MobileControls mounts too. Roster gets one row.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  await waitForLocalShip(page);
  await waitForJoystickMounted(page);

  const before = await countJoysticks(page);
  expect(before.zones, 'sanity: exactly one joystick zone before swap').toBe(1);
  expect(before.joysticks, 'sanity: exactly one nipplejs handle before swap').toBe(1);

  // Step 2 — read the spawned shipId out of the Zustand singleton.
  // The roster fetch may not have populated yet — sync via the
  // /dev/player-ships endpoint and write into the store ourselves.
  const playerId = await page.evaluate(() => {
    return window.localStorage.getItem('eqxPlayerId') ?? '';
  });
  expect(playerId, 'eqxPlayerId persisted post-spawn').not.toBe('');

  const roster = await page.evaluate(async (pid) => {
    const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
    const body = (await res.json()) as { ships?: RosterEntry[] };
    return body.ships ?? [];
  }, playerId);
  expect(roster.length, 'server roster has the spawned ship').toBeGreaterThanOrEqual(1);

  await page.evaluate((ships) => {
    const win = window as unknown as StoreWindow;
    win.__eqxStore!.getState().setShipRoster(ships);
  }, roster);

  // Step 3 — dispatch the ship-swap. Same shipId, same sector — the
  // path is structurally identical from MobileControls' POV.
  // App.tsx runs `game → connecting → game`.
  await page.evaluate(({ shipId, sectorKey }) => {
    const win = window as unknown as StoreWindow;
    win.__eqxStore!.getState().setPendingShipSwap({ shipId, sectorKey });
  }, { shipId: roster[0]!.shipId, sectorKey: roster[0]!.sectorKey });

  // Step 4 — wait for the swap to complete. Phase returns to 'game';
  // GameSurface remounts; MobileControls remounts; new joystick zone
  // appears. Allow up to 15 s for the reconnect cycle to land.
  await page.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      return win.__eqxStore!.getState().phase === 'game';
    },
    { timeout: 15_000 },
  );
  await waitForLocalShip(page);
  await waitForJoystickMounted(page);

  // Give the swap an extra beat to settle — if the old joystick's
  // destroy is async or runs after a layout tick, this is where the
  // race would surface.
  await page.waitForTimeout(500);

  // Step 5 — the smoking gun. After a clean swap, exactly ONE
  // joystick zone and ONE nipplejs handle.
  const after = await countJoysticks(page);
  expect(
    after.zones,
    `Expected exactly 1 [data-testid="mobile-joystick"] after ship-swap, got ${after.zones}. ` +
      'Two zones means TWO MobileControls instances mounted simultaneously — ' +
      'GameSurface unmount race.',
  ).toBe(1);
  expect(
    after.joysticks,
    `Expected exactly 1 .joystick element after ship-swap, got ${after.joysticks}. ` +
      'Two nipplejs handles mean the old MobileControls cleanup did not tear down ' +
      'its joystick DOM before the new mount created its replacement. ' +
      'Smoking gun for the 2026-05-14 user-reported "two thumbsticks" bug.',
  ).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
