/**
 * 2026-06-03 deterministic combat split — replaces old combat.spec.ts test 8
 * (the spray-and-pray 12s kill loop that used a conditional skip).
 *
 * Geometry (engineering room, test-sector, testMode):
 *   - Shooter: interceptor at (0,0), initialAngle 0 -> faces +y
 *     (forward = (-sin0, cos0) = (0,1)); holding Space fires a CONTINUOUS
 *     hitscan beam straight up +y. Beam range 250u; 2 beams x 13 dmg = 26
 *     dmg per 6 Hz trigger.
 *   - Victim: parked at (0,200) (200u < 250u range) with initialShield 0
 *     (first beam tick lands on hull) and initialHull 10 (< 26 dmg -> dies in a
 *     single trigger).
 *
 * Asserts deterministically (caught atomically at the death frame so the
 * transient alert + possible respawn don't race the read):
 *   (1) victim data-hull-pct reaches 0,
 *   (2) victim data-sector-alert === 'SHIP DESTROYED'.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getHullPct, getSectorAlert } from '../helpers/gameScenario';

test('victim sees its own death: hull hits 0, alert reads SHIP DESTROYED', async ({
  browser,
}) => {
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
    initialHull: 10,
    shipKind: 'interceptor',
    testId,
  });
  try {
    expect(await getHullPct(victim.page)).toBeGreaterThan(0);

    // Shooter holds Space: one 26-dmg trigger kills the 10-hull victim.
    await shooter.page.keyboard.down('Space');

    // Catch the death lifecycle ATOMICALLY: at destruction the victim's own
    // surface reports hull 0 AND the 'SHIP DESTROYED' sector alert together.
    // Asserting them in SEPARATE steps races — the alert is transient (clears
    // after a few seconds) and the ship may later respawn (hull back > 0), so a
    // multi-step / settle-window predicate intermittently never re-satisfies.
    // A single predicate catches the death frame when both are simultaneously
    // true; reading them back immediately (sub-frame gap) is then stable.
    await victim.page.waitForFunction(
      () => {
        const surface = document.querySelector('[data-testid="game-surface"]');
        return (
          surface?.getAttribute('data-hull-pct') === '0' &&
          surface?.getAttribute('data-sector-alert') === 'SHIP DESTROYED'
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    expect(await getHullPct(victim.page)).toBe(0);
    expect(await getSectorAlert(victim.page)).toBe('SHIP DESTROYED');
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});
