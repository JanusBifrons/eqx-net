/**
 * `ProjectileWeapon` — a ballistic bolt (the catalogue 'projectile' mode). At
 * fire time it spawns a server projectile that inherits the shooter's velocity
 * (`shooterV + dir * speed`) so bolts lead while strafing; collision is resolved
 * per-tick by `ProjectilePipeline`, not here. No fire-time hit + no `laser_fired`
 * broadcast (the projectile rides the snapshot `projectiles[]` slice).
 */

import { Weapon, type WeaponFireContext, type WeaponFireSink } from './Weapon.js';
import type { ProjectileWeaponDef, WeaponId } from '../WeaponCatalogue.js';

export class ProjectileWeapon extends Weapon {
  readonly id: WeaponId;

  constructor(private readonly def: ProjectileWeaponDef) {
    super();
    this.id = def.id;
  }

  resolveFire(ctx: WeaponFireContext, sink: WeaponFireSink): void {
    sink.spawnProjectile(
      ctx,
      ctx.shooterVx + ctx.dirX * this.def.speed,
      ctx.shooterVy + ctx.dirY * this.def.speed,
      this.def.damage,
      this.def.radius,
      this.def.maxTicks,
      this.def.id,
    );
  }
}
