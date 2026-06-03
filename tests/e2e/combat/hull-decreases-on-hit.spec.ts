/**
 * Deterministic combat split (2026-06-03, test-coverage-audit Phase 3) — was
 * combat.spec.ts test 5, which sprayed-and-prayed on random positions with a
 * conditional assertion that silently passed when no hit landed.
 *
 * Geometry that makes a hit GUARANTEED (no RNG): shooter interceptor at (0,0)
 * facing +y (angle 0 → forward = (-sin0, cos0) = (0,1)) fires a hitscan beam
 * along +y. Victim parked at (0,200), inside the 250u beam range, with shields
 * down (initialShield:0) so the first beam tick lands on the hull. A held beam
 * is then a repeatable, unconditional hit.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getHullPct } from '../helpers/gameScenario';

test('hitscan beam hits a parked victim: hull decreases', async ({ browser }) => {
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
    initialHull: 100,
    testId,
  });
  try {
    const initialHull = await getHullPct(victim.page);
    expect(initialHull, 'victim should spawn with hull > 0').toBeGreaterThan(0);

    await shooter.page.keyboard.down('Space');
    await victim.page.waitForFunction(
      (init) => {
        const h = parseInt(
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') ?? '100',
          10,
        );
        return h < init;
      },
      initialHull,
      { timeout: 5_000 },
    );
    expect(await getHullPct(victim.page)).toBeLessThan(initialHull);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});
