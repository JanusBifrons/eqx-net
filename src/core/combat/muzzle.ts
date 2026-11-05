/**
 * Turret barrel geometry + muzzle points — ONE source for both sides
 * (invariant #15, plan T3).
 *
 * The Machined turrets draw a barrel sized to its hull or structure; a shot
 * must leave that barrel's tip on the server (fire ray, projectile / missile
 * spawn) and on the client (prediction ghosts, live beam, remote beam
 * origin). Sizes are in entity-local world units:
 *
 *  - a TURNING ship mount (any arc) pivots on the mount: barrel length
 *    max(7, R × 0.7) up to 40 u, cap max(3, wid × 1.5) up to 9 u — missile racks are a box with no
 *    barrel, their tubes at cap × 0.8;
 *  - a FIXED CENTRE ship gun is a chin gun: the shot keeps leaving the
 *    side's existing clearance (players 20 u, drones 16 u), so
 *    `shipMountMuzzle` returns null and callers keep their constant;
 *  - a structure turret is sized to its footprint (R = half the smaller
 *    side): barrel R × 0.68, rack tubes at R × 0.32.
 *
 * Pure, zone-blind, allocation-free.
 */
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon, type WeaponId } from './WeaponCatalogue.js';

/** A fixed gun at the hull centre (no arc): drawn as a chin gun. */
export function isChinMount(m: WeaponMount): boolean {
  return m.localX === 0 && m.localY === 0 && m.arcMin === 0 && m.arcMax === 0;
}

export function isRackWeapon(weaponId: string): boolean {
  return getWeapon(weaponId as WeaponId).mode === 'missile';
}

/** Turret size caps, so a capital hull (radius ~200) gets turrets, not cannons
 *  the size of a fighter. */
const BARREL_LEN_MAX = 40, BARREL_WID_MAX = 6, CAP_MAX = 9, RACK_CAP_MAX = 10;

/** Barrel width of a turning ship mount (world units). */
export function shipBarrelWidth(radius: number): number { return Math.min(BARREL_WID_MAX, Math.max(2, radius * 0.17)); }
/** Barrel length of a turning ship mount (world units). */
export function shipBarrelLength(radius: number): number { return Math.min(BARREL_LEN_MAX, Math.max(7, radius * 0.7)); }
/** Cap radius of a turning ship mount (a rack's box half-width). */
export function shipCapRadius(radius: number, rack: boolean): number {
  return rack ? Math.min(RACK_CAP_MAX, Math.max(3.2, radius * 0.2)) : Math.min(CAP_MAX, Math.max(3, shipBarrelWidth(radius) * 1.5));
}

/**
 * Distance from a ship mount's pivot to where its shot leaves, or null for a
 * chin gun (the caller keeps its existing clearance).
 */
export function shipMountMuzzle(kind: Pick<ShipKind, 'radius'>, m: WeaponMount): number | null {
  if (isChinMount(m)) return null;
  const R = kind.radius;
  if (isRackWeapon(m.weaponId)) return shipCapRadius(R, true) * 0.8;
  return shipBarrelLength(R);
}

/** Half the smaller footprint side of a structure kind (its turret's R). */
export function structureTurretRadius(kindId: string): number {
  const sk = getStructureKind(kindId);
  return Math.min(sk.footprint?.w ?? 140, sk.footprint?.h ?? 140) / 2;
}

/** Distance from a structure's centre to where its turret's shot leaves. */
export function structureTurretMuzzle(kindId: string, weaponId: string): number {
  const R = structureTurretRadius(kindId);
  return isRackWeapon(weaponId) ? R * 0.32 : R * 0.68;
}
