import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * UI-driven regression lock for the 2026-05-13 smoke-test failure:
 * "Join → spawn → switch ship → nothing there." This spec drives
 * the **real UI clicks** the user makes — drawer-toggle → Galaxy
 * tab → roster card → Spawn button — rather than dispatching the
 * underlying Zustand intent.
 *
 * Why a separate test from `happy-path-switch-ship.spec.ts`:
 *   The programmatic test catches the room-swap CYCLE (predWorld,
 *   phase machine, mirror reset). This test catches anything in
 *   the UI path between user click and Zustand dispatch — disabled
 *   button, modal not opening, mount-loops, etc.
 *
 * Prerequisites:
 *   - The ShipDetailModal's Spawn button is **disabled** for the
 *     player's currently-piloted hull (`isMyPilotedShip`). So a
 *     switch-ship test needs at least TWO ships in the roster. This
 *     spec seeds two ships by spawning twice in two contexts that
 *     share the Playwright storageState (same player, same auth).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface StoreState {
  playerId: string | null;
  phase: string;
  setShipRoster: (ships: { shipId: string; sectorKey: string }[]) => void;
}
interface StoreWindow extends Window {
  __eqxStore?: { getState: () => StoreState };
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

async function spawnInSector(
  page: Page,
  sectorKey: string,
  opts: { newShip?: boolean } = {},
): Promise<string> {
  const newShipParam = opts.newShip ? '&newShip=1' : '';
  await page.goto(
    `${BASE_URL}/?galaxy=${sectorKey}${newShipParam}`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  await waitForLocalShip(page);
  const playerId = await page.evaluate(() => {
    const win = window as unknown as StoreWindow;
    return win.__eqxStore!.getState().playerId;
  });
  expect(playerId, 'playerId should be set after welcome').toBeTruthy();
  return playerId!;
}

async function fetchRoster(
  page: Page,
  playerId: string,
): Promise<{ shipId: string; sectorKey: string; kind: string }[]> {
  return page.evaluate(async (pid) => {
    const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
    if (!res.ok) throw new Error(`roster fetch failed ${res.status}`);
    const body = (await res.json()) as { ships: { shipId: string; sectorKey: string; kind: string }[] };
    return body.ships;
  }, playerId);
}

/**
 * Marked `fixme` 2026-05-13 — the test runs the right surface but is
 * currently flaky:
 *   - Passes solo on a fresh DB: full path runs in ~58 s.
 *   - On repeat runs (test DB accumulating roster rows) sometimes
 *     hits "Target page, context or browser has been closed" mid-
 *     swap, or fails to open the drawer after the toggle click.
 *
 * Both modes look like state pollution + timing races between the
 * two simulated browser pages. Fix candidates (not yet attempted):
 *   - Reset the player's roster via a new `/dev/reset-roster` endpoint
 *     before each run.
 *   - Replace the two-page sequence with a single-page navigation +
 *     `?newShip=1` so the Colyseus disconnect is exactly one
 *     close-and-reopen cycle instead of a page close racing a page
 *     spawn.
 *   - Add explicit waits on `player_lingered` server event before
 *     the second spawn so we know the first ship is fully durable
 *     before the roster query.
 *
 * The companion `happy-path-switch-ship.spec.ts` exercises the same
 * room-swap CYCLE programmatically (rebind path) and is stable, so
 * the regression-lock value isn't lost while this UI test settles.
 */
test.fixme('UI happy-path: drawer → Galaxy tab → roster card → Spawn renders the new ship', async ({
  browser,
}) => {
  // Two spawns + drawer flow + post-swap render is two real Colyseus
  // round-trips plus ~3s of intentional waits. The default 30 s
  // Playwright timeout is too tight.
  test.setTimeout(90_000);
  const errors: string[] = [];

  // Single shared context so the durable `eqxPlayerId` in localStorage
  // (set after the first connect's welcome) persists across the two
  // pages — both consequently bind to the same server-side player and
  // contribute to the same roster.
  const ctx: BrowserContext = await browser.newContext();

  // === Page 1: spawn ship A in sol-prime, then close. ===
  const page1 = await ctx.newPage();
  page1.on('pageerror', (err) => errors.push(`page1 PAGEERROR: ${err.message}`));
  const playerId = await spawnInSector(page1, 'sol-prime');
  // Confirm the roster has ship A BEFORE closing — sanity check for
  // the spawn → dual-write → /dev/player-ships read path.
  const rosterAfterFirstSpawn = await fetchRoster(page1, playerId);
  expect(rosterAfterFirstSpawn.length, 'roster should contain ship A').toBeGreaterThanOrEqual(1);
  const shipAId = rosterAfterFirstSpawn[0]!.shipId;
  await page1.close(); // triggers Colyseus onLeave → ship A lingers in player_ships table

  // Give the server's `onLeave` a beat to finalize the linger + the
  // `PLAYER_SHIP_PUT` to drain through the persistence worker. Without
  // this, the roster fetch below races the dual-write and only sees
  // the freshly-active ship B.
  await new Promise((r) => setTimeout(r, 1500));

  // === Page 2: spawn ship B in a different sector (same context). ===
  // After the second spawn the roster has both ships (lingering A + active B).
  const page2 = await ctx.newPage();
  page2.on('pageerror', (err) => errors.push(`page2 PAGEERROR: ${err.message}`));
  const playerId2 = await spawnInSector(page2, 'orion-belt', { newShip: true });
  // Sanity: both pages share localStorage → same eqxPlayerId.
  expect(playerId2).toBe(playerId);

  // Server-side roster should now have at least 2 entries — the
  // lingering ship A and the freshly-active ship B. Poll up to 5 s
  // because the dual-write goes through the persistence worker
  // (50 ms WAB flush + batch write).
  let roster = await fetchRoster(page2, playerId);
  for (let attempt = 0; attempt < 10 && roster.length < 2; attempt++) {
    await page2.waitForTimeout(500);
    roster = await fetchRoster(page2, playerId);
  }
  // Helpful failure dump so we can see what state landed.
  expect(
    roster.length,
    `expected >=2 ships in roster, got ${roster.length}.\n` +
      `ship A id: ${shipAId}\n` +
      `roster: ${JSON.stringify(roster, null, 2)}`,
  ).toBeGreaterThanOrEqual(2);

  // === Drive the UI. ===
  // Push the fetched roster into Zustand so the panel sees it without
  // waiting for its own 3 s poll.
  await page2.evaluate((ships) => {
    const win = window as unknown as StoreWindow;
    win.__eqxStore!.getState().setShipRoster(ships);
  }, roster);

  // Open the drawer.
  await page2.locator('[data-testid="drawer-toggle"]').click();
  await expect(page2.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });

  // Galaxy tab is default-selected (per src/client/CLAUDE.md); we
  // just need to assert the panel is mounted with a roster panel inside.
  await expect(page2.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 5_000 });
  await expect(page2.locator('[data-testid="ship-roster-panel"]')).toBeVisible({ timeout: 5_000 });

  // Pick a ship that is NOT the active hull. The active hull's
  // Spawn button is disabled (the user can't "switch to themselves"
  // — that's a no-op trip cycle). The lingering ship A is the
  // canonical target.
  const localShipInstanceId = await page2.evaluate(() => {
    const win = window as unknown as { __eqxStore: { getState: () => { localShipInstanceId: string | null } } };
    return win.__eqxStore.getState().localShipInstanceId;
  });
  const nonActiveShip = roster.find((s) => s.shipId !== localShipInstanceId);
  expect(nonActiveShip, 'expected a non-active ship in the roster').toBeTruthy();

  // Click the non-active ship's card — the ShipDetailModal opens.
  await page2.locator(`[data-testid="ship-roster-card-${nonActiveShip!.shipId}"]`).first().click();
  await expect(page2.locator('[data-testid="ship-detail-modal"]')).toBeVisible({ timeout: 5_000 });
  await expect(page2.locator('[data-testid="ship-detail-spawn"]')).toBeEnabled();

  // Click Spawn. This is the user's "switch ship" action.
  await page2.locator('[data-testid="ship-detail-spawn"]').click();

  // The drawer closes itself on submit (Phase 5 contract). Phase
  // cycles game → connecting → game; GameSurface unmounts + remounts.
  // Wait for the phase machine to land back on 'game' BEFORE asserting
  // the ship render — otherwise we race the disposed-but-not-remounted
  // window where the old page is being torn down (which can manifest
  // as "Target page, context or browser has been closed" in CI).
  await page2.waitForFunction(
    () => {
      const win = window as unknown as StoreWindow;
      return win.__eqxStore?.getState().phase === 'game';
    },
    { timeout: 10_000 },
  );
  // The CRITICAL assertion: the new ship MUST render after the cycle.
  await waitForLocalShip(page2, 25_000);

  expect(errors, errors.join('\n')).toEqual([]);

  // Close the page explicitly before the context teardown so the
  // Colyseus client's leave() finishes draining before the WS gets
  // killed by ctx.close(). Without this, the cleanup races and the
  // next test in the file can see a "context closed" error mid-step.
  await page2.close();
  await ctx.close();
});
