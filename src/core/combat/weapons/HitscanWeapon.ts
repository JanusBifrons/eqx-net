/**
 * `HitscanWeapon` — an instant-hit beam (the catalogue 'hitscan' mode). At fire
 * time it casts a ray of its `range` and the nearest hit takes `damage`. The
 * candidate sweep (lag-comp for players, live for AI) + the `laser_fired`
 * broadcast are server work, so this just dispatches `sink.hitscan(range, damage)`.
 */

import { Weapon, type WeaponFireContext, type WeaponFireSink } from './Weapon.js';
import type { HitscanWeaponDef, WeaponId } from '../WeaponCatalogue.js';

export class HitscanWeapon extends Weapon {
  readonly id: WeaponId;

  constructor(private readonly def: HitscanWeaponDef) {
    super();
    this.id = def.id;
  }

  resolveFire(ctx: WeaponFireContext, sink: WeaponFireSink): void {
    // P3.13 — `range` is the OPTIMAL (full-damage) range; the ray reaches
    // `range × maxRangeMul` (maxRange) with reverse-square falloff beyond
    // optimal. maxRangeMul absent/≤1 ⇒ maxRange = range (flat, back-compat).
    const f = this.def.falloff;
    const maxRange = f?.maxRangeMul && f.maxRangeMul > 1 ? this.def.range * f.maxRangeMul : this.def.range;
    sink.hitscan(ctx, this.def.range, this.def.damage, f?.minDamageFrac, maxRange);
  }
}
