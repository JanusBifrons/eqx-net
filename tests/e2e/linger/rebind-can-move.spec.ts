/**
 * Regression lock for the 2026-06-03 smoke bug: rebinding to a lingering
 * hull leaves the ship UNCONTROLLABLE.
 *
 * USER REPORTED: "Spawned as an interceptor in Sol. Went back to menu.
 * Spawned in as another interceptor... Instead respawned me in that same
 * interceptor and I couldn't move."
 *
 * The galaxy-map "rejoin the same sector" path (no isNewShip) rebinds the
 * player to their LINGERING hull (SectorRoom `else` branch). The server side
 * of this is proven clean by `respawnInputApplies.test.ts` ("REBIND" case) —
 * after the handshake the server applies thrust and moves the ship. So the
 * "can't move" lives CLIENT-side: on rebind the ship first arrives as
 * `isActive=false` (a lingering hull in the mirror) and must be rescued into
 * the local active ship + predWorld; if that rescue is incomplete the local
 * player can't control it.
 *
 * This drives the same in-app respawn cascade (game→connecting→game) the
 * sector-pick uses, but in the linger-capable `galaxy-test` room so the
 * rejoin REBINDS instead of fresh-spawning (engineering rooms never linger,
 * which is why `respawn-cascade-input-routing.spec.ts` couldn't catch this).
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { getShipX, getShipY } from '../helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForHandshake(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-loading-active="0"]') !== null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1200); // join-broadcast grace + first snapshot
}

async function thrustDisplacement(page: Page): Promise<number> {
  const sx = await getShipX(page);
  const sy = await getShipY(page);
  await page.keyboard.down('w');
  await page.waitForTimeout(600);
  await page.keyboard.up('w');
  await page.waitForTimeout(200); // drain the input ack
  const ex = await getShipX(page);
  const ey = await getShipY(page);
  return Math.hypot(ex - sx, ey - sy);
}

test('rebind: thrust moves the ship after a respawn cascade that rebinds to a lingering hull @feature', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const pid = randomUUID();
  await ctx.addInitScript((p) => {
    try {
      localStorage.setItem('eqxPlayerId', p as string);
    } catch {
      /* ignore */
    }
  }, pid);
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'galaxy-test',
    testId: `rebind-${randomUUID()}`,
    shipKind: 'interceptor',
    spawnX: '0',
    spawnY: '0',
  });
  await page.goto(`${BASE_URL}/?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForHandshake(page);

  // Baseline — thrust moves the ship on the first (fresh) spawn.
  expect(await thrustDisplacement(page), 'baseline: thrust must move the ship').toBeGreaterThan(1);

  // "Went back to menu" — leave the game so the ship LINGERS in the sector.
  // A short in-app cascade fresh-spawns (the linger hasn't settled yet), so
  // we leave to the galaxy map and WAIT for the linger to arm before
  // rejoining — guaranteeing the server's rebind (else) branch fires.
  await page.evaluate(() => {
    (window as unknown as { __eqxStore?: { getState: () => { setPhase: (p: string) => void } } }).__eqxStore
      ?.getState()
      .setPhase('galaxy-map');
  });
  await page.waitForTimeout(2500); // let onLeave → linger settle (ownerless timer armed)

  // "Spawned in as another interceptor" — rejoin the same sector WITHOUT
  // isNewShip → the server rebinds to the lingering hull.
  await page.evaluate(() => {
    (window as unknown as { __eqxStore?: { getState: () => { setPhase: (p: string) => void } } }).__eqxStore
      ?.getState()
      .setPhase('game');
  });
  await waitForHandshake(page);

  // The bug: the rebound ship is pinned — thrust produces no movement.
  expect(
    await thrustDisplacement(page),
    'thrust must move the ship after rebinding to the lingering hull',
  ).toBeGreaterThan(1);

  await ctx.close();
});
