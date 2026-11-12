/**
 * Hostile review of the capital-turrets clip (2026-11-12,
 * `showcase-capital-duel`, 13.0-14.5 s): the battleship's 16" shells left
 * points and flew directions ~45-60 degrees away from its drawn barrels. The
 * shot spectates (free camera), and from that moment the drawn turrets stood
 * still while the server's kept training and fired from the real barrels.
 *
 * Measured with this flow before the fix: after Spectate the battleship's
 * `mirror.swarm[..].mountAngles` froze at [-56, -79, 81] deg for 40 s while
 * the hull pose kept updating. Cause: the client applied the snapshot's drone
 * slice only for a pilot with an own active ship (unit lock:
 * src/client/net/ColyseusClient.spectatorTurrets.test.ts).
 *
 * Flow: join the duel room as the heavy cruiser 4,000 u off the battleship's
 * starboard beam, start the fight (`test_aggro`), wait until the main
 * turrets are training, spectate, then check the drawn angles keep moving
 * (a 16" turret turns 4 deg/s, so ~20 deg in 5 s).
 */
import { test, expect } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

const ROOM = 'showcase-capital-duel' as unknown as 'test-sector';

/** The battleship's first main turret angle (deg) as the client holds it. */
async function mainTurretDeg(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; mountAngles?: number[] }> } } }).__eqxClient;
    let a: number | null = null;
    c?.mirror.swarm.forEach((e) => { if (e.kind === 1 && e.mountAngles) a = (e.mountAngles[0]! * 180) / Math.PI; });
    return a;
  });
}

test('a spectator keeps seeing an NPC capital train its turrets', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await launchTestClient(browser, {
    room: ROOM, spawnX: 4000, spawnY: 0, shipKind: 'heavy-cruiser', initialHull: 1_000_000,
    extraParams: { worker: '0' }, joinTimeoutMs: 60_000,
  });
  await page.waitForFunction(() => {
    const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
    let n = 0;
    c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n > 0;
  }, undefined, { timeout: 30_000 });
  await page.evaluate(() => (globalThis as unknown as { __eqxClient: { getRoom(): { send(t: string, m: unknown): void } } }).__eqxClient.getRoom().send('test_aggro', { type: 'test_aggro' }));
  // The lock takes ~2.6 s; then the 16" turrets train toward the beam.
  await page.waitForFunction(() => {
    const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; mountAngles?: number[] }> } } }).__eqxClient;
    let a = 0;
    c?.mirror.swarm.forEach((e) => { if (e.kind === 1 && e.mountAngles) a = Math.abs(e.mountAngles[0]!); });
    return a > (5 * Math.PI) / 180;
  }, undefined, { timeout: 30_000 });

  await page.locator('[data-testid="spectator-toggle"]').first().click({ timeout: 10_000 });
  await page.waitForFunction(
    () => (window as unknown as { __eqxStore?: { getState(): { pilotMode?: string } } }).__eqxStore?.getState().pilotMode === 'spectator',
    undefined, { timeout: 5000 },
  );
  const before = await mainTurretDeg(page);
  await page.waitForTimeout(5000); // the turret's own traverse (4 deg/s), not a sync wait
  const after = await mainTurretDeg(page);
  expect(before, 'turret angles missing on spectate').not.toBeNull();
  expect(Math.abs((after ?? 0) - (before ?? 0)), `drawn main turret froze while spectating (${before?.toFixed(1)} -> ${after?.toFixed(1)} deg)`).toBeGreaterThan(5);
});
