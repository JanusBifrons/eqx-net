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
import { MUZZLE_CLEARANCE } from '../../../core/combat/Weapons.js';
import { familyFor, type TurretFamily } from './fx/turretFx.js';

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
}

function familyOf(m: WeaponMount): TurretFamily {
  const w = getWeapon(m.weaponId as WeaponId);
  return familyFor(m.weaponId, w.mode, w.mode === 'hitscan' && (w.chargeTicks ?? 0) > 0);
}

/** Turret places for a ship kind's catalogue mounts. */
export function shipTurrets(kindId: string): TurretPlace[] {
  const k = getShipKind(kindId);
  const R = k.radius;
  return (k.mounts ?? []).map((m) => {
    const family = familyOf(m);
    const chin = m.localX === 0 && m.localY === 0 && m.arcMin === 0 && m.arcMax === 0;
    if (chin) {
      const len = Math.min(MUZZLE_CLEARANCE * 0.55, Math.max(7, R * 0.7));
      const wid = Math.max(2, R * 0.17);
      const cap = Math.max(2.4, wid * 1.25);
      return { mount: m, family, px: 0, py: -(MUZZLE_CLEARANCE - len), len, wid, cap, ring: cap * 1.35, chin: true };
    }
    if (family === 'missile') {
      const cap = Math.max(3.2, R * 0.2);
      return { mount: m, family, px: m.localX, py: -m.localY, len: 0, wid: cap, cap, ring: cap * 1.45, chin: false };
    }
    const wid = Math.max(2, R * 0.17);
    const cap = Math.max(3, wid * 1.5);
    return { mount: m, family, px: m.localX, py: -m.localY, len: Math.max(7, R * 0.7), wid, cap, ring: cap * 1.35, chin: false };
  });
}

/** Turret places for a structure kind's weapon mounts. Miner drills are not
 *  turrets (they keep their drill line), so they're left out. */
export function structureTurrets(kindId: string): TurretPlace[] {
  const sk = getStructureKind(kindId);
  const R = Math.min(sk.footprint?.w ?? 140, sk.footprint?.h ?? 140) / 2;
  return (sk.mounts ?? []).filter((m) => m.id !== 'drill').map((m) => {
    const family = familyOf(m);
    if (family === 'missile') {
      const cap = R * 0.4;
      return { mount: m, family, px: m.localX, py: -m.localY, len: 0, wid: cap, cap, ring: cap * 1.3, chin: false };
    }
    const cap = R * 0.34;
    return { mount: m, family, px: m.localX, py: -m.localY, len: R * 0.68, wid: R * 0.13, cap, ring: cap * 1.3, chin: false };
  });
}

/** Distance from the pivot to where the shot leaves (the gun tip). */
export function muzzleReach(t: TurretPlace): number {
  return t.chin ? t.len : Math.max(t.len, t.cap * 0.8);
}

const HAS = new Map<string, boolean>();
/** Whether a kind has any turret (so its bake gets rings). Cached per kind. */
export function hasTurrets(kindId: string, structure: boolean): boolean {
  const k = (structure ? 's:' : 'p:') + kindId;
  let v = HAS.get(k);
  if (v === undefined) { v = (structure ? structureTurrets(kindId) : shipTurrets(kindId)).length > 0; HAS.set(k, v); }
  return v;
}
