/**
 * Linger E2E — closing the browser leaves the hull lingering in the world.
 *
 * "These ships linger if a player disconnects or closes a browser, they
 * don't just vanish immediately." Owner A spawns and then closes its browser
 * context (drops the socket); a 2nd observer B must see A's hull appear as a
 * lingering hull and STAY (not vanish, not become a wreck) for several
 * seconds. No lingerMs override → the production 15-min window applies, so
 * the hull cannot evict during the test.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  launchGalaxyTestClient,
  getShipPositions,
  getLingeringPositions,
} from '../helpers/gameScenario';
import { captureGameScene } from '../helpers/screenshot';

test.describe('linger: closing the browser leaves a lingering hull @feature', () => {
  test('after A closes its browser, the observer keeps seeing A’s hull lingering', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const testId = randomUUID();
    const A_X = 300;
    const A_Y = 180;

    const a = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'fighter',
      spawnX: A_X,
      spawnY: A_Y,
    });
    const b = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'scout',
      spawnX: -300,
      spawnY: -180,
    });
    const aPlayerId = a.playerId;

    // B sees both ships active.
    await expect
      .poll(async () => Object.keys(await getShipPositions(b.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // A closes its browser (drops the WebSocket) — the hull should LINGER.
    await a.ctx.close();

    // B now sees A's hull as a lingering hull at ≈ A's pose.
    await expect
      .poll(
        async () => {
          const lingers = await getLingeringPositions(b.page);
          return Object.values(lingers).some((l) => l.ownerPlayerId === aPlayerId);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const lingers = await getLingeringPositions(b.page);
    const entry = Object.values(lingers).find((l) => l.ownerPlayerId === aPlayerId)!;
    expect(Math.abs(entry.x - A_X)).toBeLessThan(80);
    expect(Math.abs(entry.y - A_Y)).toBeLessThan(80);

    await captureGameScene(b.page, 'disconnect-hull-persists-observer');

    // It must NOT vanish — still lingering 3 s later.
    await b.page.waitForTimeout(3_000);
    const lingersLater = await getLingeringPositions(b.page);
    expect(
      Object.values(lingersLater).some((l) => l.ownerPlayerId === aPlayerId),
      'lingering hull must persist (not vanish)',
    ).toBe(true);

    await b.ctx.close();
  });
});
