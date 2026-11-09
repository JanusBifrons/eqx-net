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
 *  - a CAPITAL ship mount with an explicit `size` (S/M/L/XL, capital-ship
 *    R&D) is sized to the hull BEAM by calibre class: a 16" (XL) barrel
 *    is ~half the beam, a 5" (S) secondary ~a fifth (WW2 proportions).
 *
 * Pure, zone-blind, allocation-free (the beam is cached per kind).
 */
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon, type WeaponId } from './WeaponCatalogue.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { CAPITAL_TURRETS } from '../../shared-types/shipScale/capitalTurrets.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

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
const beamCache = new WeakMap<ShipKind, number>();
function hullBeam(kind: ShipKind): number {
  let b = beamCache.get(kind);
  if (b === undefined) {
    const hull = (kind.shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull;
    b = 0;
    if (hull) for (const p of hull) b = Math.max(b, Math.abs(p[0]) * 2);
    if (b === 0) b = kind.radius * 0.25;
    beamCache.set(kind, b);
  }
  return b;
}
/** A capital naval turret in world units (gunhouse + barrels), or null for
 *  any other mount. Geometry from the shared `CAPITAL_TURRETS` table × the
 *  hull beam × the mount's `turretScale`. */
export interface NavalTurret { houseW: number; houseL: number; barbette: number; len: number; wid: number; barrels: number }
const navalCache = new WeakMap<WeaponMount, NavalTurret>();
export function navalTurret(kind: ShipKind, m?: WeaponMount): NavalTurret | null {
  if (m === undefined || m.size === undefined || kind.sizeClass !== 'capital') return null;
  let t = navalCache.get(m);
  if (t === undefined) {
    const g = CAPITAL_TURRETS[m.size], s = hullBeam(kind) * (m.turretScale ?? 1);
    t = { houseW: g.houseW * s, houseL: g.houseL * s, barbette: g.barbette * s, len: g.len * s, wid: g.wid * s, barrels: m.barrels ?? 1 };
    navalCache.set(m, t);
  }
  return t;
}
/** Barrels of a naval turret span this fraction of the gunhouse width (the
 *  bake and the fire path both read it, so each shell leaves a drawn tip). */
export const NAVAL_BARREL_SPAN = 0.62;
/** Sideways offset of barrel `k` (0..barrels-1) from the turret centreline,
 *  in world units, + to the gun's right. 0 for a single barrel. */
export function navalBarrelOffset(t: NavalTurret, k: number): number {
  if (t.barrels <= 1) return 0;
  const pitch = (t.houseW * NAVAL_BARREL_SPAN) / (t.barrels - 1);
  return (k - (t.barrels - 1) / 2) * pitch;
}
function capitalTurret(kind: ShipKind, m?: WeaponMount): { len: number; wid: number; cap: number } | null {
  const t = navalTurret(kind, m);
  return t === null ? null : { len: t.len, wid: t.wid, cap: t.houseW / 2 };
}

export function shipBarrelWidth(kind: ShipKind, m?: WeaponMount): number {
  const c = capitalTurret(kind, m);
  if (c) return c.wid;
  const t = shipTuning(kind);
  return Math.min(t.barrelWidMax, Math.max(t.barrelWidMin, kind.radius * 0.17));
}
/** Barrel length of a turning ship mount (world units). */
export function shipBarrelLength(kind: ShipKind, m?: WeaponMount): number {
  const c = capitalTurret(kind, m);
  if (c) return c.len;
  const t = shipTuning(kind);
  return Math.min(t.barrelLenMax, Math.max(t.barrelLenMin, kind.radius * 0.7));
}
/** Cap radius of a turning ship mount (a rack's box half-width). */
export function shipCapRadius(kind: ShipKind, rack: boolean, m?: WeaponMount): number {
  const c = capitalTurret(kind, m);
  if (c) return c.cap;
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
  if (isRackWeapon(m.weaponId)) return shipCapRadius(kind, true, m) * 0.8;
  // A naval turret's barrels start at the gunhouse front face.
  const nt = navalTurret(kind, m);
  if (nt !== null) return nt.houseL / 2 + nt.len;
  return shipBarrelLength(kind, m);
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

/**
 * Coastal defences (plan coastal-defences): a structure mount with a calibre
 * `size` is a naval gun, drawn and fired exactly like the same calibre on a
 * ship. Its geometry is `CAPITAL_TURRETS[size]` × the beam of the ship class
 * that carries that calibre (5" and quad AA: the battleship's secondaries;
 * 8": a heavy cruiser; 11-12": a battlecruiser; 16": a battleship) ×
 * `turretScale`. So a 16" barbette's gunhouse is a battleship turret's size.
 */
const STRUCTURE_GUN_REFERENCE: Readonly<Record<NonNullable<WeaponMount['size']>, string>> = {
  AA: 'battleship', S: 'battleship', M: 'heavy-cruiser', L: 'battlecruiser', XL: 'battleship',
};
const structureNavalCache = new WeakMap<WeaponMount, NavalTurret>();
export function structureNavalTurret(m: WeaponMount | undefined): NavalTurret | null {
  if (m === undefined || m.size === undefined) return null;
  let t = structureNavalCache.get(m);
  if (t === undefined) {
    const g = CAPITAL_TURRETS[m.size];
    const s = hullBeam(getShipKind(STRUCTURE_GUN_REFERENCE[m.size])) * (m.turretScale ?? 1);
    t = { houseW: g.houseW * s, houseL: g.houseL * s, barbette: g.barbette * s, len: g.len * s, wid: g.wid * s, barrels: m.barrels ?? 1 };
    structureNavalCache.set(m, t);
  }
  return t;
}

/** Where a structure mount's shot leaves, from the mount pivot: a naval
 *  gun's barrel tip (gunhouse front + barrel), else the footprint-sized
 *  turret's muzzle. One source for the server fire path and the art (#15). */
export function structureMountMuzzle(kindId: string, m: WeaponMount): number {
  const nt = structureNavalTurret(m);
  if (nt !== null) return nt.houseL / 2 + nt.len;
  return structureTurretMuzzle(kindId, m.weaponId);
}
