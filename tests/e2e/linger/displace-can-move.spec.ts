/**
 * Regression lock for the 2026-06-03 smoke bug: after spawning a NEW ship in
 * a sector where you already have a lingering hull, you were bound to the OLD
 * (invisible, uncontrollable) lingering hull instead of the new active ship.
 *
 * USER REPORTED: "Spawned as an interceptor in Sol. Went back to menu.
 * Spawned in as another interceptor... respawned me in that same interceptor
 * and I couldn't move. I didn't see the ship I left to linger either... AI
 * ships were shooting the 'lingering' ship despite it being invisible."
 *
 * Root cause (locked deterministically at the routing seam by
 * `snapshotShipRouter.ownShip.test.ts`): a displaced player owns TWO hulls
 * under one playerId; the client identified "my ship" by playerId, so the old
 * displaced hull could clobber the new active ship at mirror.ships[playerId].
 *
 * This E2E drives the user's flow end-to-end: spawn ship A at (0,0), then
 * "spawn another" — a fresh ship B at (600,0) via ?newShip=1 (the galaxy-map
 * sector-pick path) which displaces A into a lingering hull. It asserts the
 * local view binds to B (at its spawn, NOT the old hull at ~0,0) AND that
 * thrust moves it.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { getShipX, getShipY, getLingeringPositions } from '../helpers/gameScenario';

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
  await page.waitForTimeout(200);
  const ex = await getShipX(page);
  const ey = await getShipY(page);
  return Math.hypot(ex - sx, ey - sy);
}

test('displace: spawning a new ship over a lingering hull binds + moves the NEW ship @feature', async ({
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
  const testId = `displace-${randomUUID()}`;

  // First spawn (interceptor) at (0,0) in the linger-capable galaxy-test room.
  await page.goto(
    `${BASE_URL}/?room=galaxy-test&testId=${testId}&shipKind=interceptor&spawnX=0&spawnY=0`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  await waitForHandshake(page);
  expect(await thrustDisplacement(page), 'baseline: thrust must move the first ship').toBeGreaterThan(1);

  // "Back to menu → spawn another interceptor": a FRESH ship (isNewShip) at
  // (600,0). The old socket drops → the server lingers the first hull → the
  // rejoin displaces it. Same playerId (seeded localStorage) → same flow as
  // the galaxy-map sector-pick.
  await page.goto(
    `${BASE_URL}/?room=galaxy-test&testId=${testId}&shipKind=interceptor&newShip=1&spawnX=600&spawnY=0`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  await waitForHandshake(page);

  // The local view must be the NEW ship (spawned near x=600), NOT the OLD
  // lingering hull (~x=0). Before the fix the client could bind to the old
  // hull → data-ship-x stuck near 0 ("pinned in my old interceptor").
  const boundX = await getShipX(page);
  expect(
    Math.abs(boundX - 600),
    `local view must bind to the NEW ship near x=600, not the lingering hull near x=0 (got x=${boundX.toFixed(1)})`,
  ).toBeLessThan(250);

  // And it must be controllable.
  expect(
    await thrustDisplacement(page),
    'after spawning a new ship over a lingering hull, thrust must move the NEW ship',
  ).toBeGreaterThan(1);

  // The OWNER must SEE their own displaced hull as a lingering ship in the
  // world — "be able to see their own ship there" (2026-06-03 "I can't see
  // the lingering ships" report). Owners used to be excluded from their own
  // lingering hulls; now they render for the owner too.
  await expect
    .poll(
      async () => {
        const lingers = await getLingeringPositions(page);
        return Object.values(lingers).some((l) => l.ownerPlayerId === pid);
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await ctx.close();
});
