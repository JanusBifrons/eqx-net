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
 *  - a FIXED CENTRE ship gun is a chin gun: the shot leaves the kind's
 *    chin clearance (`shipTuning`: players 20 u, drones 16 u at 1×), via
 *    `shipShotMuzzle` (`shipMountMuzzle` returns null for it);
 *  - a structure turret is sized to its footprint (R = half the smaller
 *    side): barrel R × 0.68, rack tubes at R × 0.32.
 *
 * Pure, zone-blind, allocation-free.
 */
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon, type WeaponId } from './WeaponCatalogue.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

/** A fixed gun at the hull centre (no arc): drawn as a chin gun. */
export function isChinMount(m: WeaponMount): boolean {
  return m.localX === 0 && m.localY === 0 && m.arcMin === 0 && m.arcMax === 0;
}

export function isRackWeapon(weaponId: string): boolean {
  return getWeapon(weaponId as WeaponId).mode === 'missile';
}

// Sizes follow the hull and its class: the caps and minimums come from the
// kind's tuning (shipScale/tuning.ts), so a 2× hull or a capital gets turrets
// in proportion (at 1× they are the old 40 / 6 / 9 / 10 and 7 / 2 / 3 / 3.2).

/** Barrel width of a turning ship mount (world units). */
export function shipBarrelWidth(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.min(t.barrelWidMax, Math.max(t.barrelWidMin, kind.radius * 0.17));
}
/** Barrel length of a turning ship mount (world units). */
export function shipBarrelLength(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.min(t.barrelLenMax, Math.max(t.barrelLenMin, kind.radius * 0.7));
}
/** Cap radius of a turning ship mount (a rack's box half-width). */
export function shipCapRadius(kind: ShipKind, rack: boolean): number {
  const t = shipTuning(kind);
  return rack
    ? Math.min(t.rackCapMax, Math.max(t.rackCapMin, kind.radius * 0.2))
    : Math.min(t.capMax, Math.max(t.capMin, shipBarrelWidth(kind) * 1.5));
}

/**
 * Distance from a ship mount's pivot to where its shot leaves, or null for a
 * chin gun (the caller keeps its existing clearance).
 */
export function shipMountMuzzle(kind: ShipKind, m: WeaponMount): number | null {
  if (isChinMount(m)) return null;
  if (isRackWeapon(m.weaponId)) return shipCapRadius(kind, true) * 0.8;
  return shipBarrelLength(kind);
}

/** Where a ship's shot leaves a mount: the barrel tip of a turning turret,
 *  else the kind's chin-gun clearance (players; drones pass `drone`). */
export function shipShotMuzzle(kind: ShipKind, m: WeaponMount, drone = false): number {
  const t = shipTuning(kind);
  return shipMountMuzzle(kind, m) ?? (drone ? t.droneMuzzleClearance : t.muzzleClearance);
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
