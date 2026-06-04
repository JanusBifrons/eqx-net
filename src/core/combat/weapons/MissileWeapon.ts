/**
 * `MissileWeapon` — a heat-seeking missile (the catalogue 'missile' mode). At
 * fire time it spawns a server missile in its fire direction; lock-at-launch,
 * homing, and splash all live inside `MissileSimulation` (the simulation owns
 * the lifecycle + emits `missile_fired` / `missile_detonated`). No fire-time hit
 * resolution + no `laser_fired` broadcast.
 */

import { Weapon, type WeaponFireContext, type WeaponFireSink } from './Weapon.js';
import type { MissileWeaponDef, WeaponId } from '../WeaponCatalogue.js';

export class MissileWeapon extends Weapon {
  readonly id: WeaponId;

  constructor(private readonly def: MissileWeaponDef) {
    super();
    this.id = def.id;
  }

  resolveFire(ctx: WeaponFireContext, sink: WeaponFireSink): void {
    sink.spawnMissile(ctx, this.def);
  }
}
