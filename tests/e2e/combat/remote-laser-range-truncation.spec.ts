import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getRemoteHitTargets, getRemoteLaserRanges } from '../helpers/gameScenario';

/**
 * 2026-06-03 deterministic combat split — replaces old combat.spec.ts test 12
 * ("remote laser range truncation"), which hardcoded a STALE HITSCAN_RANGE of
 * 500. The interceptor beam range is now 250u (WeaponCatalogue HITSCAN_DEF.range
 * dropped 500 → 250 in the 2026-06-01 energy/AI overhaul), so the old absolute
 * threshold no longer described a hit.
 *
 * Geometry: shooter interceptor at (0,0) angle 0 faces +y (forward =
 * (-sin0, cos0) = (0,1)) and fires a hitscan beam straight up +y. The victim is
 * parked at (0,200) with shields down, well inside the 250u beam range. When the
 * beam HITS the victim (its targetId appears in data-remote-hit-targets), the
 * wire-side beam range is TRUNCATED to the hit distance (~180u from the beam
 * origin to the victim) — strictly less than the full 250u range. We assert both
 * that a hit is registered AND that the minimum reported remote laser range is
 * below 250 (i.e. it was truncated to the impact point rather than drawn to full
 * length). The geometry guarantees the hit, so the final expects are
 * unconditional.
 */

// Mirrors src/core/combat/WeaponCatalogue.ts HITSCAN_DEF.range. MUST be updated
// here if the catalogue's hitscan beam range changes — a stale value is exactly
// the bug this test replaces (old test 12 hardcoded 500).
const HITSCAN_RANGE = 250;

test('remote laser range is truncated to the impact point when the beam hits a victim', async ({
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
    // High HP so the victim SURVIVES the whole test: a dying victim (≈156 DPS
    // kills a default-kind hull in <1s) would stop being hit, and the final
    // range re-read could land post-death (full range / empty) — the flake the
    // determinism proof caught. A live victim keeps the beam truncated.
    initialHull: 9000,
    testId,
  });
  try {
    await shooter.page.keyboard.down('Space');
    await victim.page.waitForFunction(
      (fullRange) => {
        const surface = document.querySelector('[data-testid="game-surface"]');
        const targets = JSON.parse(
          surface?.getAttribute('data-remote-hit-targets') ?? '[]',
        ) as string[];
        const ranges = JSON.parse(
          surface?.getAttribute('data-remote-laser-ranges') ?? '{}',
        ) as Record<string, number>;
        const values = Object.values(ranges);
        return targets.length > 0 && values.some((r) => r < fullRange);
      },
      HITSCAN_RANGE,
      { timeout: 5_000 },
    );

    const hitTargets = await getRemoteHitTargets(victim.page);
    const ranges = await getRemoteLaserRanges(victim.page);
    expect(hitTargets.length).toBeGreaterThan(0);
    expect(Math.min(...Object.values(ranges))).toBeLessThan(HITSCAN_RANGE);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await victim.ctx.close();
  }
});
