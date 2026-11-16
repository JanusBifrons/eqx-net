/**
 * Showcase review (#376, gpu-lit-ships, `capital-guns-fighter` take): "A thin
 * dark rod sticks out behind each 5-inch turret, opposite its barrels."
 *
 * Found with an in-game probe (hide the turret clusters: the rod stays; hide
 * the hull: it goes): the rod is in the HULL bake, not the turret art. The
 * hull's vent-slit greeble (three slits a third of the way up from the stern,
 * sized for a fighter) lands on a capital as a one-texel-thick, ~110 u long
 * TRIM line. On the battleship it ran straight out of the quad 40 mm AA tubs
 * at aa-s2 / aa-p2 (the small turrets the review called 5-inch), whose guns
 * cover its outboard end, so it read as a rod behind the turret. The baked
 * frames and the GPU-lit maps come from the same fields, so both showed it.
 *
 * Lock: no vent slit touches a turret ring (its stamped extent, r × 1.15).
 * Kinds: the battleship from the review here, plus the other capitals whose
 * slits hit a ring before the fix in `hullVents.battleshipC.test.ts` and
 * `hullVents.lightCruiserC.test.ts`. Nothing is sampled or shrunk: each kind
 * is forged at its real ppu (the slit size and placement depend on it), and
 * one kind per FILE because vitest spreads files, not tests, over workers;
 * one file forging all three set the unit job's wall-clock (239 s on CI with
 * coverage, almost all of it `rasterPoly`). The check lives in
 * `__fixtures__/hullVentsLock.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ventsTouchingRings } from './__fixtures__/hullVentsLock.js';

describe('capital hull vents stay clear of turret rings', () => {
  it('battleship', () => {
    expect(ventsTouchingRings('battleship')).toEqual([]);
  }, 60_000);
});
