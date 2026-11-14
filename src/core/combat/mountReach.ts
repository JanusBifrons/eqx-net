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
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { HITSCAN_RANGE } from './Weapons.js';
import { shipHitBound, shipWithinHullReach } from './shipHitShape.js';
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

/**
 * The target's hit shape for the per-mount range gate (owner decision
 * 2026-11-14: fire range is measured from EACH turret to the nearest point of
 * the target's TRUE hull). A ship (`kindId` set): its hull polygon, or its
 * shield bubble when a non-capital's shield is up (`shipHitShape`, the shape
 * its hits use). Anything else: a circle of `radius` (absent = a point).
 */
export interface MountRangeTarget {
  readonly kindId?: string | null;
  readonly angle?: number;
  readonly shieldUp?: boolean;
  readonly radius?: number;
}

/** A circle round the target's centre containing its whole hit shape. */
export function mountRangeBound(t: MountRangeTarget | null | undefined): number {
  if (!t) return 0;
  if (t.kindId != null) return shipHitBound(t.kindId);
  return t.radius ?? 0;
}

/**
 * Is target `t` at offset (dx, dy) from a mount within `reach` of it, measured
 * to the nearest point of its hit shape? The one range gate of every turret
 * (NPC capitals and drones, structures, the player lock share-out). Cheap
 * first: a ship is rejected on its bounding circle before the polygon.
 * Pure, allocation-free.
 */
export function mountInReach(dx: number, dy: number, reach: number, t: MountRangeTarget | null | undefined): boolean {
  if (t?.kindId != null) return shipWithinHullReach(t.kindId, t.shieldUp === true, 0, 0, dx, dy, t.angle ?? 0, reach);
  const r = reach + (t?.radius ?? 0);
  return dx * dx + dy * dy <= r * r;
}

/** Cheap candidate test for a turret's target search: the target's centre is
 *  within `reach` + its `mountRangeBound`, so its hull MAY be in reach
 *  (`mountInReach` decides). */
export function mayBeInReach(dx: number, dy: number, reach: number, t: MountRangeTarget | null | undefined): boolean {
  const r = reach + mountRangeBound(t);
  return dx * dx + dy * dy <= r * r;
}

let maxBound = -1;
/** The largest `mountRangeBound` any ship kind can have: how far past a
 *  gun's reach a candidate search must look for a hull that may be in it. */
export function maxShipRangeBound(): number {
  if (maxBound >= 0) return maxBound;
  let m = 0;
  for (const k of SHIP_KINDS_LIST) m = Math.max(m, shipHitBound(k.id));
  maxBound = m;
  return m;
}
