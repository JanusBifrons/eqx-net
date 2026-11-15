/**
 * RTS take-controls: the ship you take over is really yours at once.
 *
 * Reported (hostile review of the filmed rts-command take, 2026-11-14):
 * after "take controls" (double-click a parked hull → `pilot_ship`) the
 * followed ship and camera stepped at ~6 Hz (a jump every 9–10 frames with
 * near-still frames between) for the whole ~11 s the pilot flew it.
 *
 * Root cause found while reproducing: the server reclaims the hull through the
 * join handshake (`pendingJoin`, `isActive=false` until `client_ready` →
 * `warp_in` → arrival), but the client never sent `client_ready` again (it is
 * latched once per room join), so the flown hull stayed "joining" until the
 * 30 s watchdog: no own-ship energy / fire-control / wallet slices, hidden from
 * every other player, and outside every ACTIVE-ship loop on the server, for the
 * whole time you fly it.
 *
 * Flow, as a player: join in Command view (the hull parks as an AI-flown
 * wingman), click the hull, Fly → you pilot it; the server must list the hull
 * ACTIVE within the normal arrival window (well under the 30 s watchdog).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient } from './helpers/gameScenario';
import type { Page } from '@playwright/test';

const SURFACE = '[data-testid="game-surface"]';

/** What the renderer draws under a mirror key (`__eqxShipVisualProbe`, `?worker=0`). */
interface ShipVisual { sprite: number | null; cluster: number | null; artHandle: number | null; rekeys: number }

async function shipVisual(page: Page, key: string): Promise<ShipVisual | null> {
  return page.evaluate((k) => {
    const p = (globalThis as { __eqxShipVisualProbe?: (key: string) => unknown }).__eqxShipVisualProbe;
    return (p ? p(k) : null) as ShipVisual | null;
  }, key);
}

/** The mirror key of a parked (AI-flown) hull owned by `owner` (default: me). */
async function parkedHullKey(page: Page, owner?: string): Promise<string | null> {
  return page.evaluate((o) => {
    const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string }> } } }).__eqxClient?.mirror;
    if (!m) return null;
    const want = o ?? m.localPlayerId;
    for (const [k, e] of m.ships) if (e.isActive === false && e.ownerPlayerId === want) return k;
    return null;
  }, owner ?? null);
}

/** Click the own parked hull (where it is drawn) until it is selected. */
async function selectOwnHull(page: Page): Promise<void> {
  const hullAt = async (): Promise<{ x: number; y: number } | null> => {
    const p = await page.evaluate(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
      const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
      for (const e of m?.ships?.values() ?? []) {
        if (e.isActive === false && e.ownerPlayerId === m?.localPlayerId && toScreen) return toScreen(e.x, e.y);
      }
      return null;
    });
    if (p === null) return null;
    const box = (await page.locator(SURFACE).boundingBox())!;
    return { x: p.x + box.x, y: p.y + box.y };
  };
  await expect.poll(hullAt, { timeout: 15_000, message: 'own parked hull drawn' }).not.toBeNull();
  await expect.poll(async () => {
    const sel = await page.locator(SURFACE).getAttribute('data-fleet-sel-count');
    if (sel === '1') return sel;
    const h = await hullAt();
    if (h) await page.mouse.click(h.x, h.y);
    return sel;
  }, { timeout: 6_000, intervals: [500], message: 'click selects the hull' }).toBe('1');
}

/** The ship drawn under `key`, once its sprite has settled (art swap done). */
async function settledVisual(page: Page, key: string): Promise<ShipVisual> {
  let last: ShipVisual | null = null;
  await expect.poll(async () => {
    const v = await shipVisual(page, key);
    const stable = v !== null && v.sprite !== null && last !== null && last.sprite === v.sprite && last.cluster === v.cluster;
    last = v;
    return stable;
  }, { timeout: 15_000, intervals: [700], message: `ship ${key} drawn and settled` }).toBe(true);
  return last!;
}

async function waitPilotMode(page: Page, mode: 'pilot' | 'spectator'): Promise<void> {
  await page.waitForFunction(
    (m) => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === m, mode,
    { timeout: 10_000 },
  );
}

test.describe('RTS take controls @feature', () => {
  test('the ship you take over is active on the server at once', async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await launchGalaxyTestClient(browser, {
      testId: randomUUID(), shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
    });
    const { page } = a;
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
      { timeout: 15_000 },
    );
    // The own parked hull, where it is drawn (it is AI-flown, so it may drift).
    const hullAt = async (): Promise<{ x: number; y: number } | null> => {
      const p = await page.evaluate(() => {
        const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
        const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
        for (const e of [...(m?.ships?.values() ?? [])].filter((e) => e.isActive === false)) {
          if (e.ownerPlayerId === m?.localPlayerId && toScreen) return toScreen(e.x, e.y);
        }
        return null;
      });
      if (p === null) return null;
      const box = (await page.locator(SURFACE).boundingBox())!;
      return { x: p.x + box.x, y: p.y + box.y };
    };
    await expect.poll(hullAt, { timeout: 15_000, message: 'own parked hull drawn' }).not.toBeNull();
    await expect.poll(async () => {
      const sel = await page.locator(SURFACE).getAttribute('data-fleet-sel-count');
      if (sel === '1') return sel;
      const h = await hullAt();
      if (h) await page.mouse.click(h.x, h.y);
      return sel;
    }, { timeout: 6_000, intervals: [500], message: 'click selects the hull' }).toBe('1');

    await page.locator('[data-testid="pilot-toggle"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'pilot', undefined,
      { timeout: 10_000 },
    );
    const t0 = Date.now();
    // The server's own record of the flown hull (room state), not the client's.
    await page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; localShipInstanceId?: string | null }; getRoom(): { state: { ships: Map<string, { isActive: boolean }> } } | null } }).__eqxClient;
      const id = c?.mirror.localShipInstanceId;
      if (!c || !id) return false;
      return c.getRoom()?.state.ships.get(id)?.isActive === true;
    }, undefined, { timeout: 5_000 }).catch(() => undefined);
    const active = await page.evaluate(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { localShipInstanceId?: string | null }; getRoom(): { state: { ships: Map<string, { isActive: boolean }> } } | null } }).__eqxClient;
      const id = c?.mirror.localShipInstanceId;
      return id ? c?.getRoom()?.state.ships.get(id)?.isActive ?? null : null;
    });
    expect(active, `flown hull still "joining" on the server ${Date.now() - t0} ms after Fly (the client never re-sent client_ready)`).toBe(true);
    await a.ctx.close();
  });

  /**
   * Owner requirement (RTS Part A v2): taking the controls of a fleet ship is
   * SEAMLESS. The ship's mirror key changes (shipInstanceId -> playerId and
   * back on Command); before the fix the renderer dropped everything under
   * the old key and rebuilt the ship under the new one (a new sprite, art
   * handle and turret cluster: the flicker). The SAME sprite object, turret
   * cluster and art handle must be drawn under the new key, both ways.
   */
  test('taking and letting go of the controls keeps the same drawn ship (no rebuild)', async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await launchGalaxyTestClient(browser, {
      testId: randomUUID(), shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
    });
    const { page } = a;
    await waitPilotMode(page, 'spectator');
    await selectOwnHull(page);
    const hullKey = (await parkedHullKey(page))!;
    expect(hullKey).not.toBeNull();
    const before = await settledVisual(page, hullKey);

    await page.locator('[data-testid="pilot-toggle"]').click();
    await waitPilotMode(page, 'pilot');
    const localId = await page.evaluate(() => (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null } } }).__eqxClient?.mirror.localPlayerId ?? null);
    await expect.poll(async () => (await shipVisual(page, localId!))?.sprite ?? null, { timeout: 5_000, message: 'flown ship drawn under the playerId' }).not.toBeNull();
    const flown = (await shipVisual(page, localId!))!;
    expect(flown.sprite, 'take controls: the same sprite object (not rebuilt)').toBe(before.sprite);
    expect(flown.cluster, 'take controls: the same turret cluster').toBe(before.cluster);
    expect(flown.artHandle, 'take controls: the same art handle').toBe(before.artHandle);
    expect((await shipVisual(page, hullKey))?.sprite ?? null, 'nothing left under the hull key').toBeNull();

    // Let go again (Command): the ship goes back to its shipInstanceId.
    await page.locator('[data-testid="spectator-toggle"]').click();
    await waitPilotMode(page, 'spectator');
    await expect.poll(async () => (await shipVisual(page, hullKey))?.sprite ?? null, { timeout: 5_000, message: 'parked ship drawn under its shipInstanceId' }).not.toBeNull();
    const parked = (await shipVisual(page, hullKey))!;
    expect(parked.sprite, 'Command: the same sprite object (not rebuilt)').toBe(before.sprite);
    expect(parked.cluster, 'Command: the same turret cluster').toBe(before.cluster);
    // It stays the same ship once the server has parked it (no late rebuild).
    await page.waitForFunction((k) => {
      const c = (globalThis as { __eqxClient?: { getRoom(): { state: { ships: Map<string, { isActive: boolean }> } } | null } }).__eqxClient;
      return c?.getRoom()?.state.ships.get(k)?.isActive === false;
    }, hullKey, { timeout: 5_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect((await shipVisual(page, hullKey))?.sprite, 'still the same sprite after the server parks it').toBe(before.sprite);
    await a.ctx.close();
  });

  test("another pilot taking their parked ship's controls keeps it drawn as the same ship", async ({ browser }) => {
    test.setTimeout(120_000);
    const testId = randomUUID();
    const a = await launchGalaxyTestClient(browser, {
      testId, shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
    });
    const b = await launchGalaxyTestClient(browser, {
      testId, shipKind: 'fighter', spawnX: 300, spawnY: 0,
    });
    await waitPilotMode(a.page, 'spectator');
    const aId = a.playerId;
    // B sees A's parked hull under its shipInstanceId.
    await expect.poll(() => parkedHullKey(b.page, aId), { timeout: 15_000, message: "B sees A's parked hull" }).not.toBeNull();
    const hullKey = (await parkedHullKey(b.page, aId))!;
    const before = await settledVisual(b.page, hullKey);

    await selectOwnHull(a.page);
    await a.page.locator('[data-testid="pilot-toggle"]').click();
    await waitPilotMode(a.page, 'pilot');
    // B now draws it as A's ship, under A's playerId: the same sprite.
    await expect.poll(async () => (await shipVisual(b.page, aId))?.sprite ?? null, { timeout: 10_000, message: "B draws A's flown ship" }).not.toBeNull();
    const flown = (await shipVisual(b.page, aId))!;
    expect(flown.sprite, "remote take controls: B keeps the same sprite").toBe(before.sprite);
    expect(flown.cluster, 'remote take controls: B keeps the same turret cluster').toBe(before.cluster);
    expect((await shipVisual(b.page, hullKey))?.sprite ?? null, 'nothing left under the hull key').toBeNull();
    await a.ctx.close();
    await b.ctx.close();
  });
});
