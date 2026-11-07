/**
 * How far a ship's turrets look for a target (plan prancy-squishing-donut
 * Phase 3). Shared by the server's mount ticker (players + drones) and the
 * client's local mount aim, so both sides pick the same target (#12, #15).
 *
 * Ordinary ships keep the fixed `HITSCAN_RANGE` they have always used, so
 * nothing changes for them. A capital measures from its centre, and its guns
 * sit far from the centre with reaches of thousands of units: the fixed 250 u
 * meant a battleship could never engage anything outside its own hull. A
 * capital's reach is its longest gun's engage range plus that mount's offset.
 */
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds.js';
import { HITSCAN_RANGE } from './Weapons.js';
import { getWeapon, weaponAutoFireRange } from './WeaponCatalogue.js';

/** Engage range of one mount's weapon, from the mount. */
export function mountWeaponReach(mount: Pick<WeaponMount, 'weaponId'>): number {
  return weaponAutoFireRange(getWeapon(mount.weaponId));
}

const cache = new Map<string, number>();

/** Target-pick radius from the ship's centre for this kind and mount list. */
export function mountTargetReach(kind: Pick<ShipKind, 'id' | 'sizeClass'>, mounts: ReadonlyArray<WeaponMount>): number {
  if (kind.sizeClass !== 'capital') return HITSCAN_RANGE;
  const hit = cache.get(kind.id);
  if (hit !== undefined) return hit;
  let r = HITSCAN_RANGE;
  for (const m of mounts) {
    const reach = mountWeaponReach(m) + Math.hypot(m.localX, m.localY);
    if (reach > r) r = reach;
  }
  cache.set(kind.id, r);
  return r;
}

/** True for a kind whose turrets fire one by one under their own fire
 *  control (capitals), instead of with the hull's aim. */
export function hasTurretFireControl(kind: Pick<ShipKind, 'sizeClass'>): boolean {
  return kind.sizeClass === 'capital';
}
