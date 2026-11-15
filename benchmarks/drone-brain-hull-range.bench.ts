/**
 * Drone brain range-to-hull cost. `HostileDroneBehaviour.tickCombat` measures
 * its fire / stop distance to the target's HULL (same shape the fire gate
 * uses), every AI tick for every drone in combat. Cheap first: past
 * `shipHitBound + fireRange` the centre distance minus the bound settles it;
 * only near range is the polygon measured.
 *
 * Rows compare one full combat tick against the same target with no kind
 * (centre distance only, the pre-hull path) versus a shielded fighter
 * (bubble circle), a battleship far off (bound reject) and a battleship in
 * reach (polygon). The bare `shipHullDistance` rows isolate the shape cost.
 * Print-only: timings compare, they never gate (root CLAUDE.md).
 *
 * Module-level setup only (vitest 2.1 bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import { HostileDroneBehaviour } from '../src/core/ai/HostileDroneBehaviour.js';
import type { AiEntity, AiWorldView } from '../src/core/contracts/IAiBehaviour.js';
import { shipHullDistance } from '../src/core/combat/shipHitShape.js';

const SELF: AiEntity = { id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

function combatRow(kindId: string | undefined, distFactor: number, shieldUp: boolean): () => void {
  const brain = new HostileDroneBehaviour();
  brain.markHostile('t', 0);
  const R = brain.getFireRange();
  // Battleship rows place the HULL at distFactor × fireRange; others the centre.
  let y = R * distFactor;
  if (kindId === 'battleship' && distFactor < 2) {
    while (shipHullDistance('battleship', false, 0, 0, 0, y, 0) < R * distFactor) y += 5;
  }
  const view: AiWorldView = {
    players: [{ id: 't', x: 0, y, vx: 0, vy: 0, angle: 0.3, shieldUp, ...(kindId ? { kindId } : {}) }],
    tick: 1000,
    dtSec: 1 / 60,
  };
  return () => {
    view.tick++;
    brain.markHostile('t', view.tick);
    brain.tick(SELF, view);
  };
}

describe('drone brain — one combat tick, range to target', () => {
  bench('no kind (centre distance only)', combatRow(undefined, 0.8, false));
  bench('fighter, shield up (bubble circle)', combatRow('fighter', 0.8, true));
  bench('battleship far (bound reject)', combatRow('battleship', 20, false));
  bench('battleship hull in reach (polygon)', combatRow('battleship', 0.8, false));
});

describe('shipHullDistance alone', () => {
  let a = 0;
  bench('battleship polygon', () => { a += 0.01; shipHullDistance('battleship', false, 0, 3000, 0, 0, a); });
  bench('fighter bubble', () => { a += 0.01; shipHullDistance('fighter', true, 0, 300, 0, 0, a); });
});
