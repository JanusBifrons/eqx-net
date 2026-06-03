/**
 * Linger E2E — abandoning a LINGERING hull turns it into a wreck.
 *
 * Browser-level lock for the Step-1 correctness fix (a lingering hull is
 * still "in the game world", so abandoning it must leave a wreck, not just
 * silently expire). Owner A displaces a fighter into a lingering hull, then
 * abandons that hull via the roster endpoint; a 2nd observer B must see the
 * lingering entry become a wreck while A's active hull is untouched.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  launchGalaxyTestClient,
  getShipPositions,
  getLingeringPositions,
  getWreckPositions,
} from '../helpers/gameScenario';
import { captureGameScene } from '../helpers/screenshot';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.describe('linger: abandon a lingering hull → wreck @feature', () => {
  test('a displaced lingering hull, when abandoned, becomes a wreck the observer sees', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const testId = randomUUID();
    const A_X = 360;
    const A_Y = -240;

    const a = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'fighter',
      spawnX: A_X,
      spawnY: A_Y,
    });
    const b = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'scout',
      spawnX: -360,
      spawnY: 240,
    });

    await expect
      .poll(async () => Object.keys(await getShipPositions(b.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // A swaps to a fresh ship → the fighter is displaced into a lingering hull.
    await a.page.goto(
      `${BASE_URL}?room=galaxy-test&worker=0&testId=${testId}&shipKind=scout&newShip=1`,
    );
    await expect
      .poll(async () => Object.keys(await getShipPositions(a.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);

    // Observer resolves the lingering fighter's shipInstanceId.
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
    const fighterId = Object.keys(lingers).find((id) => lingers[id]!.ownerPlayerId === a.playerId)!;
    expect(fighterId).toBeTruthy();

    // Abandon the lingering hull (same effect as the roster panel's button).
    const resp = (await b.page.evaluate(
      async ([shipId, pid]) => {
        const r = await fetch(`/dev/player-ships/${encodeURIComponent(shipId!)}/abandon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: pid }),
        });
        return { ok: r.ok, status: r.status };
      },
      [fighterId, a.playerId],
    )) as { ok: boolean; status: number };
    expect(resp.ok, `abandon POST failed (${resp.status})`).toBe(true);

    // The lingering hull converts to a wreck the observer sees, at ≈ its pose.
    await expect
      .poll(async () => fighterId in (await getWreckPositions(b.page)), { timeout: 20_000 })
      .toBe(true);
    const wrecks = await getWreckPositions(b.page);
    expect(Math.abs(wrecks[fighterId]!.x - A_X)).toBeLessThan(80);
    expect(Math.abs(wrecks[fighterId]!.y - A_Y)).toBeLessThan(80);

    // And it is no longer a lingering hull.
    expect(fighterId in (await getLingeringPositions(b.page))).toBe(false);

    // A's active hull is untouched — A still has a ship in the world.
    expect(Object.keys(await getShipPositions(a.page)).length).toBeGreaterThanOrEqual(1);

    await captureGameScene(b.page, 'abandon-lingering-wreck-observer');

    await a.ctx.close();
    await b.ctx.close();
  });
});
