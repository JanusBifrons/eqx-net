/**
 * Linger E2E — abandoning an ACTIVE ship turns it into a wreck.
 *
 * The common abandon case: a player abandons the ship they're currently
 * flying. Because it is in the game world, it becomes a wreck. Owner A
 * spawns, then abandons its active hull via the roster endpoint; a 2nd
 * observer B must see the wreck appear at A's pose. (The eject-to-galaxy-map
 * UX of the in-game abandon button is component-tested in
 * ShipDetailModal.test.tsx; the active→wreck server path is integration-
 * locked in abandonToWreck.test.ts — this is the browser render lock.)
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  launchGalaxyTestClient,
  getShipPositions,
  getWreckPositions,
} from '../helpers/gameScenario';
import { captureGameScene } from '../helpers/screenshot';

interface RosterShip {
  shipId: string;
  isActive: boolean;
}

async function fetchRoster(
  page: import('@playwright/test').Page,
  playerId: string,
): Promise<{ ships: RosterShip[] }> {
  return (await page.evaluate(async (pid) => {
    const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
    return res.ok ? await res.json() : { ships: [] };
  }, playerId)) as { ships: RosterShip[] };
}

test.describe('linger: abandon an active ship → wreck @feature', () => {
  test('abandoning the active hull leaves a wreck the observer sees', async ({ browser }) => {
    test.setTimeout(90_000);
    const testId = randomUUID();
    const A_X = -520;
    const A_Y = 340;

    const a = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'fighter',
      spawnX: A_X,
      spawnY: A_Y,
    });
    const b = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'scout',
      spawnX: 520,
      spawnY: -340,
    });

    await expect
      .poll(async () => Object.keys(await getShipPositions(b.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // Resolve A's active roster row, then abandon it.
    await expect
      .poll(async () => (await fetchRoster(a.page, a.playerId)).ships.some((s) => s.isActive), {
        timeout: 15_000,
      })
      .toBe(true);
    const activeShipId = (await fetchRoster(a.page, a.playerId)).ships.find((s) => s.isActive)!
      .shipId;

    const resp = (await b.page.evaluate(
      async ([shipId, pid]) => {
        const r = await fetch(`/dev/player-ships/${encodeURIComponent(shipId!)}/abandon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: pid }),
        });
        return { ok: r.ok, status: r.status };
      },
      [activeShipId, a.playerId],
    )) as { ok: boolean; status: number };
    expect(resp.ok, `abandon POST failed (${resp.status})`).toBe(true);

    // The active hull converts to a wreck the observer sees, at ≈ A's pose.
    await expect
      .poll(async () => activeShipId in (await getWreckPositions(b.page)), { timeout: 20_000 })
      .toBe(true);
    const wrecks = await getWreckPositions(b.page);
    expect(Math.abs(wrecks[activeShipId]!.x - A_X)).toBeLessThan(80);
    expect(Math.abs(wrecks[activeShipId]!.y - A_Y)).toBeLessThan(80);

    await captureGameScene(b.page, 'abandon-active-wreck-observer');

    await b.ctx.close();
    await a.ctx.close();
  });
});
