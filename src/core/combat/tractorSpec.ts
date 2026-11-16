/**
 * The tractor block of a weapon record (`WeaponDefBase.tractor`, salvage plan
 * PR 11): the pull of an S-size mount; a mount pulls with force × its size's
 * `MOUNT_SIZE_TUNING.power`. Formulas: `tractorImpulse`
 * (core/physics/forceFields.ts). Keep `dRef ≤ hold`, or a load reaching the
 * cushion still feels the full force and slams.
 */
import type { HitscanWeaponDef } from './WeaponCatalogue.js';

export interface TractorSpec {
  /** F_mount at power 1 (force units: impulse per second). */
  readonly force: number;
  /** Full force inside this distance from the muzzle; inverse square past it. */
  readonly dRef: number;
  /** Cushion radius: inside it the target hovers on a damped spring. A big
   *  hull raises it past its own side for the load (`setTractorHold`). */
  readonly hold: number;
  /** Half-width of the beam line; bodies within it feel `lineFrac` × F(d). */
  readonly lineHalfWidth: number;
  readonly lineFrac: number;
  /** Game ticks one accepted fire keeps the beam on (more than a cooldown,
   *  so a held trigger never flickers it off between shots). */
  readonly leaseTicks: number;
}

/**
 * The salvage TRACTOR beam (plan partitioned-chasing-lark PR 11, owner
 * 2026-11-15): lock-anchored on ONE locked target (any ship, wreck piece, pod
 * or rock), also pulling bodies across the line muzzle → target. A fixed force
 * (acceleration F / m), only the target moves, a cushion at `hold`, thrust
 * escapes it. No damage, no ray: `mode: 'hitscan'` only gives it a `range`
 * (its reach) and the instant aim lead. Cadence like the heavy beam; a 12-tick
 * lease spans a missed shot. Absolute (never `profiled`). S mount: F 6,000 ⇒
 * a 100-mass body at 60 u/s², a 2,000-mass one at 3 u/s² (XL ×15: 45 u/s²).
 */
export const TRACTOR_DEF: HitscanWeaponDef = {
  id: 'tractor', displayName: 'Tractor beam', mode: 'hitscan',
  damage: 0, cooldownTicks: 10, range: 3000, energyCost: 4,
  tractor: { force: 6000, dRef: 250, hold: 250, lineHalfWidth: 40, lineFrac: 0.25, leaseTicks: 12 },
};

/** A tractor's pull (force units) at distance `d` from its muzzle:
 *  F(d) = force × min(1, (dRef / d)²), 0 at or beyond `reach` (and at d ≤ 0).
 *  The one falloff rule: `tractorImpulse` pulls by it, the salvage picker
 *  (`salvageTargeting.ts`) judges what a ship can haul by it. Pure. */
export function tractorPull(force: number, dRef: number, reach: number, d: number): number {
  if (d >= reach || d <= 0 || force <= 0) return 0;
  const r = dRef / d;
  return force * Math.min(1, r * r);
}
