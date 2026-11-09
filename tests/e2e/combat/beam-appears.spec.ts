/**
 * Deterministic combat split (2026-06-03, test-coverage-audit Phase 3) — was
 * combat.spec.ts tests 1+2, which held Space on `?room=sector` random ships.
 *
 * Only the interceptor fires a hitscan beam (`data-beam-active`) post weapons
 * rebalance. Lock-to-fire (2026-11-09): a group fires only at a completed
 * lock, so the beam needs a target — `combat-drone-test` parks a peaceful
 * drone at (0,200), straight ahead of the (0,0)/angle-0 interceptor. The
 * group is put in MAN (so it never auto-fires) and locked on the drone
 * (`instantLock` makes the lock complete at once); then the beam must track
 * the Space key: on while held, off on release.
 */
import { test, expect } from '@playwright/test';
import { launchTestClient, getBeamActive } from '../helpers/gameScenario';
import { lockOn, toManual } from '../helpers/fireControl';

test('hitscan beam appears while Space is held and clears on release', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    room: 'combat-drone-test',
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0,
    shipKind: 'interceptor',
    instantLock: true,
  });
  try {
    await toManual(page);
    await lockOn(page, 'first-drone');
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1', undefined,
      { timeout: 2_000 },
    );
    expect(await getBeamActive(page)).toBe(true);

    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '0', undefined,
      { timeout: 2_000 },
    );
    expect(await getBeamActive(page)).toBe(false);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
