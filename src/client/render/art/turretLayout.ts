/**
 * Where a turret sits and how big it is — one source for the
 * ring cut into the hull / deck bake and the turning gun drawn on top, so
 * the two always line up.
 *
 * Coordinates are entity-local world units in Pixi-up space (y down, nose at
 * -y), the space the hull bake and the sprite children use.
 *  - Ship turning mounts: the gun pivots on the mount, sized to the hull.
 *  - Fixed centre guns (fighter, heavy, drones): a short chin gun whose tip
 *    is today's muzzle point (MUZZLE_CLEARANCE ahead of the mount), so the
 *    shot still leaves where the server says.
 *  - Structures: sized to the footprint.
 * Pure.
 */
import { getShipKind, type WeaponMount } from '../../../shared-types/shipKinds.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { getWeapon, type WeaponId } from '../../../core/combat/WeaponCatalogue.js';
import { familyFor, type TurretFamily } from './fx/turretFx.js';
import {
  isChinMount, navalTurret, shipBarrelLength, shipBarrelWidth, shipCapRadius, shipMountMuzzle, structureTurretMuzzle, structureTurretRadius,
} from '../../../core/combat/muzzle.js';
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';

export interface TurretPlace {
  mount: WeaponMount;
  family: TurretFamily;
  /** Pivot (Pixi-up local). */
  px: number;
  py: number;
  /** Barrel length (0 for a rack), width, cap radius; ring radius in the hull. */
  len: number;
  wid: number;
  cap: number;
  ring: number;
  /** A fixed chin gun: its tip is the game's existing muzzle point. */
  chin: boolean;
  /** Pivot → where the shot leaves: the SHARED muzzle (core/combat/muzzle.ts),
   *  so the drawn tip and the server's fire point agree (#15). */
  muzzle: number;
  /** Capital naval turret: gunhouse + barrel count (shared geometry). */
  naval?: { barrels: number; houseW: number; houseL: number };
}

function familyOf(m: WeaponMount): TurretFamily {
  const w = getWeapon(m.weaponId as WeaponId);
  return familyFor(m.weaponId, w.mode, w.mode === 'hitscan' && (w.chargeTicks ?? 0) > 0);
}

/** Turret places for a ship kind's catalogue mounts. */
export function shipTurrets(kindId: string): TurretPlace[] {
  const k = getShipKind(kindId);
  return (k.mounts ?? []).map((m) => {
    const family = familyOf(m);
    if (isChinMount(m)) {
      // A chin gun ends at today's muzzle point, so its shot needs no change.
      const clear = shipTuning(k).muzzleClearance;
      const len = Math.min(clear * 0.55, shipBarrelLength(k));
      const wid = shipBarrelWidth(k);
      const cap = Math.max(2.4 * shipTuning(k).appliedScale, wid * 1.25);
      return { mount: m, family, px: 0, py: -(clear - len), len, wid, cap, ring: cap * 1.35, chin: true, muzzle: len };
    }
    const muzzle = shipMountMuzzle(k, m)!;
    if (family === 'missile') {
      const cap = shipCapRadius(k, true, m);
      return { mount: m, family, px: m.localX, py: -m.localY, len: 0, wid: cap, cap, ring: cap * 1.45, chin: false, muzzle };
    }
    const wid = shipBarrelWidth(k, m);
    const cap = shipCapRadius(k, false, m);
    const nt = navalTurret(k, m);
    if (nt !== null) {
      return { mount: m, family, px: m.localX, py: -m.localY, len: nt.len, wid, cap, ring: nt.barbette, chin: false, muzzle, naval: { barrels: nt.barrels, houseW: nt.houseW, houseL: nt.houseL } };
    }
    return { mount: m, family, px: m.localX, py: -m.localY, len: shipBarrelLength(k, m), wid, cap, ring: cap * 1.35, chin: false, muzzle };
  });
}

/** Turret places for a structure kind's weapon mounts. Miner drills are not
 *  turrets (they keep their drill line), so they're left out. */
export function structureTurrets(kindId: string): TurretPlace[] {
  const sk = getStructureKind(kindId);
  const R = structureTurretRadius(kindId);
  return (sk.mounts ?? []).filter((m) => m.id !== 'drill').map((m) => {
    const family = familyOf(m);
    const muzzle = structureTurretMuzzle(kindId, m.weaponId);
    if (family === 'missile') {
      const cap = R * 0.4;
      return { mount: m, family, px: m.localX, py: -m.localY, len: 0, wid: cap, cap, ring: cap * 1.3, chin: false, muzzle };
    }
    const cap = R * 0.34;
    return { mount: m, family, px: m.localX, py: -m.localY, len: R * 0.68, wid: R * 0.13, cap, ring: cap * 1.3, chin: false, muzzle };
  });
}

/** Distance from the pivot to where the shot leaves (the gun tip). */
export function muzzleReach(t: TurretPlace): number {
  return t.muzzle;
}

const HAS = new Map<string, boolean>();
/** Whether a kind has any turret (so its bake gets rings). Cached per kind. */
export function hasTurrets(kindId: string, structure: boolean): boolean {
  const k = (structure ? 's:' : 'p:') + kindId;
  let v = HAS.get(k);
  if (v === undefined) { v = (structure ? structureTurrets(kindId) : shipTurrets(kindId)).length > 0; HAS.set(k, v); }
  return v;
}
