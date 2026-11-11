/**
 * Structure turret tick cost under legacy vs real naval ranges
 * (docs/architecture/real-scale-ranges.md "Structure turret gather"): the
 * `npc-base-citadel` base's defence structures, each gathering every hostile
 * in reach through the room's target grid, run by the real
 * `StructureMountTicker`. One bench call = one 100 ms turret tick. Timing only;
 * the count gate is `turretGather.count.test.ts`.
 */
import { bench, describe } from 'vitest';
import { citadelTurretRig } from './turretGatherFixture.js';

describe('structure turret tick (citadel, hostiles in a 40 km disc)', () => {
  for (const hostiles of [60, 200]) {
    for (const mode of ['legacy', 'real'] as const) {
      const rig = citadelTurretRig(mode, hostiles);
      rig.tick(); // first tick makes the per-structure state
      bench(`${mode}: ${hostiles} hostiles`, () => { rig.tick(); });
    }
  }
});
