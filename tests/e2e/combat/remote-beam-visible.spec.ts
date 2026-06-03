/**
 * Deterministic combat split (2026-06-03) — replaces old combat.spec.ts tests 7 + 10.
 *
 * Test 7: a remote shooter's hitscan beam is visible to an observer (the victim
 *         renders the shooter's beam via the remote-laser mirror).
 * Test 10: the remote beam + its hit-target set clear on the observer after the
 *          shooter releases fire (remote-laser TTL ~400 ms).
 *
 * Geometry (shared by both tests):
 *   Shooter: interceptor at (0, 0), initialAngle 0. Forward = (-sin0, cos0) = (0, 1),
 *            so the hitscan beam travels straight up +y. Beam range = 250u.
 *   Victim/observer: parked at (0, 200) — 200u < 250u range, inside the beam line —
 *            with initialShield 0 (so the first beam tick lands on hull) and
 *            initialHull 100 (decreases without dying, stays alive to keep observing).
 *   Only the shooter fires (holds Space); the victim merely observes the remote beam
 *   replicated to its client mirror. The hit is geometry-guaranteed, so every final
 *   expect() is unconditional.
 *
 * Each test mints a fresh testId (separate rooms) so the two cases never share state.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getRemoteLaserCount, getRemoteHitTargets } from '../helpers/gameScenario';

test('observer sees the shooter beam', async ({ browser }) => {
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
    // High HP so the victim survives the whole test (a dying victim would stop
    // reflecting the shooter's beam and race the assertions).
    initialHull: 9000,
    testId,
  });
  try {
    await shooter.page.keyboard.down('Space');
    await victim.page.waitForFunction(
      () =>
        parseInt(
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-laser-count') ?? '0',
          10,
        ) > 0,
      undefined,
      { timeout: 5_000 },
    );
    expect(await getRemoteLaserCount(victim.page)).toBeGreaterThan(0);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});

test('remote beam + hit targets clear after the shooter stops', async ({ browser }) => {
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
    // High HP so the victim survives the whole test (a dying victim would stop
    // reflecting the shooter's beam and race the assertions).
    initialHull: 9000,
    testId,
  });
  try {
    await shooter.page.keyboard.down('Space');
    await victim.page.waitForFunction(
      () => {
        const surface = document.querySelector('[data-testid="game-surface"]');
        const count = parseInt(surface?.getAttribute('data-remote-laser-count') ?? '0', 10);
        const targets = JSON.parse(surface?.getAttribute('data-remote-hit-targets') ?? '[]') as string[];
        return count > 0 && targets.length > 0;
      },
      undefined,
      { timeout: 5_000 },
    );
    await shooter.page.keyboard.up('Space');
    await victim.page.waitForFunction(
      () =>
        parseInt(
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-laser-count') ?? '0',
          10,
        ) === 0,
      undefined,
      { timeout: 5_000 },
    );
    expect(await getRemoteLaserCount(victim.page)).toBe(0);
    expect((await getRemoteHitTargets(victim.page)).length).toBe(0);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});
