/**
 * Linger E2E — the primary user scenario.
 *
 * "A player spawns in and then switches to another ship ... should result in
 * being able to see their own ship there, up to the pool limit."
 *
 * Owner A spawns a fighter, then spawns a fresh ship (?newShip=1) which
 * displaces the fighter into a LINGERING hull. A second observer client B
 * (same galaxy-test room via shared testId) must SEE that lingering hull at
 * A's spawn pose — owners never see their own displaced hull (it's rescued
 * into mirror.ships), which is exactly why this assertion needs a 2nd client.
 * A's virtual pool grows to 2 (the lingering fighter + the new active ship).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  launchGalaxyTestClient,
  getShipPositions,
  getLingeringPositions,
} from '../helpers/gameScenario';
import { captureGameScene } from '../helpers/screenshot';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.describe('linger: spawn → swap → original lingers @feature', () => {
  test('an observer sees the swapped-away hull lingering and the pool grows to 2', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const testId = randomUUID();
    const A_X = 420;
    const A_Y = 300;

    // Owner A spawns a fighter at a known pose; observer B joins the same room.
    const a = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'fighter',
      spawnX: A_X,
      spawnY: A_Y,
    });
    const b = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'scout',
      spawnX: -420,
      spawnY: -300,
    });

    // B sees both active ships in the world.
    await expect
      .poll(async () => Object.keys(await getShipPositions(b.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // A swaps to a fresh ship — the original fighter is displaced into a
    // lingering hull (same browser context keeps A's seeded playerId).
    await a.page.goto(
      `${BASE_URL}?room=galaxy-test&worker=0&testId=${testId}&shipKind=scout&newShip=1`,
    );
    await expect
      .poll(async () => Object.keys(await getShipPositions(a.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);

    // B now sees A's ORIGINAL fighter as a lingering hull at ≈ its spawn pose.
    await expect
      .poll(
        async () => {
          const lingers = await getLingeringPositions(b.page);
          return Object.values(lingers).some((l) => l.ownerPlayerId === a.playerId);
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    const lingers = await getLingeringPositions(b.page);
    const entry = Object.values(lingers).find((l) => l.ownerPlayerId === a.playerId);
    expect(entry, 'observer must see A’s lingering hull').toBeTruthy();
    expect(Math.abs(entry!.x - A_X)).toBeLessThan(80);
    expect(Math.abs(entry!.y - A_Y)).toBeLessThan(80);

    // A's virtual pool now holds 2 ships: the lingering fighter + active scout.
    const roster = (await a.page.evaluate(async (pid) => {
      const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
      return res.ok ? await res.json() : { ships: [] };
    }, a.playerId)) as { ships: unknown[] };
    expect(roster.ships.length).toBe(2);

    // Visual confirmation that the lingering hull renders where it should.
    await captureGameScene(b.page, 'spawn-swap-lingers-observer');

    await a.ctx.close();
    await b.ctx.close();
  });
});
