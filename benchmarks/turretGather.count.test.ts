/**
 * Structure turret gather under real naval ranges (docs/architecture/
 * real-scale-ranges.md "Structure turret gather"). Counts gate (root
 * CLAUDE.md "Gate on counts, compare timings"); the per-tick time is printed
 * only. Rig: `turretGatherFixture.ts` (the `npc-base-citadel`
 * base, N hostiles in a disc round it, the room's grid + `within` gather, the
 * real `StructureMountTicker`). The layout is seeded, so the counts are the
 * same on every host.
 */
import { describe, expect, it } from 'vitest';
import { citadelTurretRig } from './turretGatherFixture.js';

const TICKS = 200;

/** Calibrated 2026-11-11: real, 60 hostiles in a 40 km disc → 126 candidates
 *  per turret tick (8 defence structures). Budget = that + 25 %. */
const REAL_60_CANDIDATES_PER_TICK_BUDGET = 160;

function measure(mode: 'legacy' | 'real', hostiles: number, radius: number) {
  const rig = citadelTurretRig(mode, hostiles, radius);
  for (let i = 0; i < 20; i++) rig.tick(); // warm
  rig.resetCounts();
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) rig.tick();
  const msPerTick = (performance.now() - t0) / TICKS;
  const c = rig.counts;
  const perTick = c.candidates / c.ticks;
  console.log(`[turret-gather] ${mode} hostiles=${hostiles} disc=${radius / 1000}km defences=${rig.defences} `
    + `gathers/tick=${c.gathers / c.ticks} candidates/structure avg=${(c.candidates / c.gathers).toFixed(1)} `
    + `max=${c.maxPerGather} candidates/tick=${perTick.toFixed(0)} ms/tick=${msPerTick.toFixed(3)} (time print-only)`);
  return { rig, perTick, gathersPerTick: c.gathers / c.ticks, maxPerGather: c.maxPerGather };
}

describe('structure turret gather (citadel, hostiles round it)', () => {
  it('one gather per defence structure per tick; real-range candidates stay in budget', () => {
    console.log(`[turret-gather] layout (real): ${citadelTurretRig('real', 0).layout}`);
    console.log(`[turret-gather] layout (legacy): ${citadelTurretRig('legacy', 0).layout}`);
    for (const [n, r] of [[200, 40_000], [60, 5_000], [200, 5_000]] as const) {
      measure('legacy', n, r);
      measure('real', n, r);
    }
    const legacy = measure('legacy', 60, 40_000);
    const real = measure('real', 60, 40_000);
    // One candidate gather per defence structure, never per mount.
    expect(real.gathersPerTick).toBe(real.rig.defences);
    expect(legacy.gathersPerTick).toBe(legacy.rig.defences);
    // A gather returns at most the hostiles there are.
    expect(real.maxPerGather).toBeLessThanOrEqual(60);
    // Real reach gathers more (the 16" / super guns see most of the disc)...
    expect(real.perTick).toBeGreaterThan(legacy.perTick);
    // ...but within the calibrated budget.
    expect(real.perTick).toBeLessThanOrEqual(REAL_60_CANDIDATES_PER_TICK_BUDGET);
  });
});
