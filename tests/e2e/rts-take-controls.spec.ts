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

const SURFACE = '[data-testid="game-surface"]';

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
});
