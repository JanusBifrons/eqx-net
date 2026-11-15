/**
 * `TractorWeapon` — the salvage tractor beam (a catalogue def with a `tractor`
 * block). It casts no ray and deals no damage: firing renews a force-field
 * lease on the mount's locked target, server work behind `sink.tractor`
 * (ForceFieldSubsystem.renewTractor). The lock gate, cooldown and energy are
 * the fire path's as for any weapon (#19).
 */

import { Weapon, type WeaponFireContext, type WeaponFireSink } from './Weapon.js';
import type { WeaponDef, WeaponId } from '../WeaponCatalogue.js';

export class TractorWeapon extends Weapon {
  readonly id: WeaponId;

  constructor(private readonly def: WeaponDef) {
    super();
    this.id = def.id;
  }

  resolveFire(ctx: WeaponFireContext, sink: WeaponFireSink): void {
    sink.tractor(ctx, this.def);
  }
}
