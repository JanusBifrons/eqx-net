/**
 * Linger E2E — multiple lingering hulls accumulate, up to the pool.
 *
 * "Up to the pool limit (but in reality unlimited, it's limited by a
 * sub-system of the maximum limit of ships)." Owner A repeatedly spawns a
 * fresh ship, displacing each previous hull into a lingering one. A 2nd
 * observer B must see ALL of A's lingering hulls coexisting, and A's virtual
 * pool grows one row per ship (bounded by ROSTER_CAP=10, never the count of
 * lingering hulls — lingering itself is unbounded below MAX_ENTITIES).
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
/** Lingering hulls to accumulate (kept small for slot/wall-clock headroom;
 *  the limit is ROSTER_CAP=10, not this — each swap is a full page-reload
 *  join ≈ 10-15 s, so this is deliberately minimal). The assertion proves
 *  N coexisting lingering hulls + roster N+1 ≤ cap; the count is incidental. */
const SWAPS = 2;

test.describe('linger: multiple lingering hulls accumulate up to the pool @feature', () => {
  test('an observer sees every displaced hull lingering and the pool grows per ship', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const testId = randomUUID();

    const a = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'fighter',
      spawnX: 320,
      spawnY: 200,
    });
    const b = await launchGalaxyTestClient(browser, {
      testId,
      shipKind: 'scout',
      spawnX: -320,
      spawnY: -200,
    });

    await expect
      .poll(async () => Object.keys(await getShipPositions(b.page)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    // Each swap displaces A's current hull into a lingering one.
    for (let i = 0; i < SWAPS; i++) {
      await a.page.goto(
        `${BASE_URL}?room=galaxy-test&worker=0&testId=${testId}&shipKind=scout&newShip=1`,
      );
      await expect
        .poll(async () => Object.keys(await getShipPositions(a.page)).length, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(1);
    }

    // B sees all SWAPS lingering hulls, every one owned by A.
    await expect
      .poll(
        async () => {
          const lingers = await getLingeringPositions(b.page);
          return Object.values(lingers).filter((l) => l.ownerPlayerId === a.playerId).length;
        },
        { timeout: 25_000 },
      )
      .toBe(SWAPS);

    // A's virtual pool = SWAPS lingering + 1 active (one roster row per ship),
    // and never exceeds the per-player ROSTER_CAP of 10.
    const roster = (await a.page.evaluate(async (pid) => {
      const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
      return res.ok ? await res.json() : { ships: [] };
    }, a.playerId)) as { ships: unknown[] };
    expect(roster.ships.length).toBe(SWAPS + 1);
    expect(roster.ships.length).toBeLessThanOrEqual(10);

    await captureGameScene(b.page, 'multiple-lingering-pool-observer');

    await a.ctx.close();
    await b.ctx.close();
  });
});
