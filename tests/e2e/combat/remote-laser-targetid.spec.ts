/**
 * 2026-06-03 deterministic combat split — replaces old combat.spec.ts test 9.
 *
 * Asserts the shooter's broadcast remote-hit-target list, as seen on the
 * VICTIM page, includes the victim's own local player id.
 *
 * Geometry: interceptor shooter at (0,0)/angle0 faces +y (forward =
 * (-sin0, cos0) = (0,1)) and fires a continuous hitscan beam straight up +y
 * while Space is held. Beam range = 250u. Victim is parked at (0,200) with
 * shields down — 200u < 250u, so it sits squarely in the beam line and the
 * shooter's hit broadcast must name it. Victim spawns with initialHull:100 so
 * it stays alive throughout, letting us keep observing the broadcast hit list.
 * The hit is geometrically guaranteed, so the final expect is unconditional.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getRemoteHitTargets, getLocalPlayerId } from '../helpers/gameScenario';

test('shooter remote-hit broadcast names the parked victim by id', async ({ browser }) => {
  const testId = randomUUID();
  const shooter = await launchTestClient(browser, {
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0,
    shipKind: 'interceptor',
    testId,
  });
  const victim = await launchTestClient(browser, {
    spawnX: 0,
    spawnY: 200,
    initialShield: 0,
    // High HP so the victim survives the whole test (a dying victim races the
    // remote-hit-target re-read after death).
    initialHull: 9000,
    testId,
  });
  try {
    // data-local-player-id is set on the welcome message, a beat after the
    // ship-count spawn gate launchTestClient waits on — wait for it explicitly.
    await victim.page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
      undefined,
      { timeout: 5_000 },
    );
    const victimId = await getLocalPlayerId(victim.page);
    expect(victimId).not.toBe('');

    await shooter.page.keyboard.down('Space');
    await victim.page.waitForFunction(
      (id) => {
        const raw =
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-hit-targets') ?? '[]';
        return (JSON.parse(raw) as string[]).includes(id);
      },
      victimId,
      { timeout: 5_000 },
    );

    expect((await getRemoteHitTargets(victim.page)).includes(victimId)).toBe(true);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});
