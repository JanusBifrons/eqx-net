/**
 * Weapon flyweight registry — one stateless `Weapon` instance per `WeaponId`,
 * built once at module load from the append-only `WeaponCatalogue`. The fire
 * resolvers look a weapon up by `mount.weaponId` and dispatch
 * `weapon.resolveFire(ctx, sink)`. Adding a weapon = a catalogue row (its mode
 * picks the leaf class here); no resolver edit.
 */

import { WEAPONS, DEFAULT_WEAPON, type WeaponId, type WeaponDef } from '../WeaponCatalogue.js';
import { Weapon } from './Weapon.js';
import { HitscanWeapon } from './HitscanWeapon.js';
import { ProjectileWeapon } from './ProjectileWeapon.js';
import { MissileWeapon } from './MissileWeapon.js';

function makeWeapon(def: WeaponDef): Weapon {
  switch (def.mode) {
    case 'hitscan':
      return new HitscanWeapon(def);
    case 'projectile':
      return new ProjectileWeapon(def);
    case 'missile':
      return new MissileWeapon(def);
  }
}

const WEAPON_OBJECTS = new Map<WeaponId, Weapon>();
for (const [id, def] of WEAPONS) {
  WEAPON_OBJECTS.set(id, makeWeapon(def));
}

/**
 * Resolve the flyweight for a weapon id. Mirrors `getWeapon`'s defensive
 * fallback to the default (hitscan) weapon so an unexpected id never crashes the
 * fire path (the id is always a valid `WeaponId` in practice — `mount.weaponId`).
 */
export function getWeaponObject(id: WeaponId): Weapon {
  return WEAPON_OBJECTS.get(id) ?? WEAPON_OBJECTS.get(DEFAULT_WEAPON)!;
}

export { Weapon } from './Weapon.js';
export type { WeaponFireContext, WeaponFireSink } from './Weapon.js';
export { HitscanWeapon } from './HitscanWeapon.js';
export { ProjectileWeapon } from './ProjectileWeapon.js';
export { MissileWeapon } from './MissileWeapon.js';
