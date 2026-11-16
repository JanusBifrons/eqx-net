/**
 * SALVAGE rules for mining mounts (salvage plan partitioned-chasing-lark
 * PR 16; owner's "smart mining lasers" rule, 2026-11-16). Pure (#14).
 *
 * A mount whose weapon MINES (`isSalvageWeapon`: a 'rock' target factor
 * above 0, the mining laser) aims at the salvage pieces its group LOCKED
 * (wreck pieces, rocks, rock pieces; class `SALVAGE_TARGET_CLASS`). Which
 * piece each laser takes is the group share-out `pickTurretLock`
 * (`turretLockPick.ts`): lasers spread ~1 per piece, big on big, and skip
 * a piece flagged `LOCK_HAULABLE`. This module answers that flag:
 * **haulable by me** = its mass is at most `salvageHaulMass` (the ship's
 * strongest tractor mount, at `SALVAGE_HAUL_DIST_PER_DREF` × dRef, gives it
 * at least `SALVAGE_HAUL_MIN_ACCEL`: the tractor's own fixed force and
 * falloff, `tractorPull`, accel = F / m) AND its hold weight fits the free
 * hold; and the big/small split (`salvagePrefersBig`).
 */
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon, weaponTargetFactor, type WeaponDef } from './WeaponCatalogue.js';
import { mountWeaponReach } from './mountReach.js';
import { tractorPull } from './tractorSpec.js';
import { SALVAGE_TARGET_CLASS } from './mountTargeting.js';

export { SALVAGE_TARGET_CLASS };

/** A tractor is judged able to haul a piece when it can accelerate it at
 *  least this much (u/s²) at the haul distance. 10 u/s² brings a piece in
 *  from 500 u in about 10 s; the tractor record's own example ("a 2,000-mass
 *  one at 3 u/s²") is the "barely moves" case this rules out. */
export const SALVAGE_HAUL_MIN_ACCEL = 10;

/** The haul distance, in multiples of the tractor's `dRef`: a piece just
 *  outside the cushion being drawn in, where the inverse-square falloff has
 *  already cut the pull to a quarter. Judging at full force (≤ dRef) would
 *  call pieces haulable that the beam can't start moving from range. */
export const SALVAGE_HAUL_DIST_PER_DREF = 2;

/** One salvage candidate (a wreck piece, a rock or a rock piece). */
export interface SalvageCandidate {
  id: string;
  x: number;
  y: number;
  /** Bounding radius: reach is judged to its edge. */
  radius: number;
  /** Body mass (the tractor accelerates it by F / mass). */
  mass: number;
  /** Hold weight it would take once stored (its pod's goods × weight). */
  holdWeight: number;
}

/** Does this weapon mine (and so pick salvage, not hostiles)? Data-driven:
 *  only a weapon naming a 'rock' factor mines (`weaponTargetFactor`). */
export function isSalvageWeapon(def: WeaponDef): boolean {
  return weaponTargetFactor(def, 'rock') > 0;
}

/** Heavy mounts take big pieces, light ones small (mountPriority's split). */
export function salvagePrefersBig(size: WeaponMount['size']): boolean {
  return size === 'M' || size === 'L' || size === 'XL';
}

const haulCache = new WeakMap<ReadonlyArray<WeaponMount>, number>();

/** The heaviest piece this ship can haul: its STRONGEST SINGLE tractor
 *  mount's `tractorPull(force × size power, dRef, reach, haul distance)`
 *  over `SALVAGE_HAUL_MIN_ACCEL`. One tractor per piece, like one laser per
 *  piece (each tractor locks its own target), so pulls never sum. 0 with no
 *  tractor. Cached per mount list. */
export function salvageHaulMass(mounts: ReadonlyArray<WeaponMount>): number {
  const hit = haulCache.get(mounts);
  if (hit !== undefined) return hit;
  let force = 0;
  for (const m of mounts) {
    const t = getWeapon(m.weaponId).tractor;
    if (t === undefined) continue;
    const power = MOUNT_SIZE_TUNING[m.size ?? 'S'].power;
    const pull = tractorPull(t.force * power, t.dRef, mountWeaponReach(m), SALVAGE_HAUL_DIST_PER_DREF * t.dRef);
    if (pull > force) force = pull;
  }
  const mass = force / SALVAGE_HAUL_MIN_ACCEL;
  haulCache.set(mounts, mass);
  return mass;
}

/** Could this ship tractor `c` in and store it? Then no laser cuts it. */
export function salvageHaulable(c: Pick<SalvageCandidate, 'mass' | 'holdWeight'>, haulMass: number, freeHold: number): boolean {
  return c.mass <= haulMass && c.holdWeight <= freeHold;
}
