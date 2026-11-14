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
import { shipHitBound, shipWithinHullReach } from './shipHitShape.js';

/** Engage range of one mount's weapon, from the mount. */
export function mountWeaponReach(mount: Pick<WeaponMount, 'weaponId'>): number {
  return weaponAutoFireRange(getWeapon(mount.weaponId));
}

/** A target for a fire-range test: a ship (`kindId`: its hit shape, shield
 *  up, via `shipWithinHullReach`) or, with no kind (a structure), a circle of
 *  `radius`. */
export interface FireRangeTarget {
  x: number;
  y: number;
  /** Hull heading (ship-angle convention); used for a ship's hull polygon. */
  angle: number;
  kindId: string | null;
  radius: number;
}

/** Per mount list: max(mount reach + mount offset), the cheap far reject. */
const outerCache = new WeakMap<ReadonlyArray<WeaponMount>, number>();
function outerReach(mounts: ReadonlyArray<WeaponMount>): number {
  let r = outerCache.get(mounts);
  if (r === undefined) {
    r = 0;
    for (const m of mounts) {
      const v = mountWeaponReach(m) + Math.hypot(m.localX, m.localY);
      if (v > r) r = v;
    }
    outerCache.set(mounts, r);
  }
  return r;
}

/**
 * Is `t` inside FIRE range of any of `mounts` (each measured from its own
 * world position on a hull at (sx, sy, sAngle), with its own gun's reach ×
 * `slack`, to the target's hit shape)? Locks work at any distance (owner
 * 2026-11-14), so this, not lock reach, says whether a gun could fire: AUTO
 * groups release a lock on it, and the "locks keep it hostile" refreshes gate
 * on it. A ship target is measured shield up (its bubble, the larger shape;
 * a capital's hull either way). Cheap first: past every mount's reach plus
 * the target's bound it is out without a per-mount test. Alloc-free (#14).
 */
export function mountsReachTarget(
  mounts: ReadonlyArray<WeaponMount>, sx: number, sy: number, sAngle: number,
  t: FireRangeTarget, slack = 1,
): boolean {
  if (mounts.length === 0) return false;
  const bound = t.kindId !== null ? shipHitBound(t.kindId) : t.radius;
  const gate = outerReach(mounts) * slack + bound;
  const cdx = t.x - sx;
  const cdy = t.y - sy;
  if (cdx * cdx + cdy * cdy > gate * gate) return false;
  const cosA = Math.cos(sAngle);
  const sinA = Math.sin(sAngle);
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]!;
    const mx = sx + (m.localX * cosA - m.localY * sinA);
    const my = sy + (m.localX * sinA + m.localY * cosA);
    const reach = mountWeaponReach(m) * slack;
    if (t.kindId !== null) {
      if (shipWithinHullReach(t.kindId, true, mx, my, t.x, t.y, t.angle, reach)) return true;
    } else {
      const dx = t.x - mx;
      const dy = t.y - my;
      const r = reach + t.radius;
      if (dx * dx + dy * dy <= r * r) return true;
    }
  }
  return false;
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
