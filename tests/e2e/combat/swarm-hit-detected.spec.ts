/**
 * 2026-06-03 deterministic combat split — replaces old combat.spec.ts test 11
 * (which spun + sprayed for 10s hoping an angle swept a random swarm entity,
 * with a conditional assertion that silently passed when nothing aligned).
 *
 * Deterministic geometry via the `combat-drone-test` room: one PEACEFUL
 * (PassiveDroneBehaviour → stationary), hull-exposed scout is parked at
 * (0,200). The shooter interceptor at (0,0)/angle0 fires a hitscan beam
 * straight up +y (200u < 250u range) and is GUARANTEED to hit the drone. An
 * observer in the same room receives the shooter's laser_fired broadcast and
 * sees the drone's `swarm-…` id in its remote-hit-targets list.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getRemoteHitTargets } from '../helpers/gameScenario';

test('observer sees the shooter hit a parked drone (swarm-N targetId)', async ({ browser }) => {
  const testId = randomUUID();
  const shooter = await launchTestClient(browser, {
    room: 'combat-drone-test',
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0,
    shipKind: 'interceptor',
    testId,
  });
  const observer = await launchTestClient(browser, {
    room: 'combat-drone-test',
    spawnX: 300,
    spawnY: 0,
    testId,
  });
  try {
    await shooter.page.keyboard.down('Space');
    await observer.page.waitForFunction(
      () => {
        const raw =
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-hit-targets') ?? '[]';
        return (JSON.parse(raw) as string[]).some((id) => id.startsWith('swarm-'));
      },
      undefined,
      { timeout: 5_000 },
    );
    expect((await getRemoteHitTargets(observer.page)).some((id) => id.startsWith('swarm-'))).toBe(true);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await observer.ctx.close();
  }
});
