/**
 * PARITY LOCK for the Generic Entity Pipeline B3 weapon flyweights.
 *
 * Each weapon's `resolveFire` must dispatch the SAME sink action with the SAME
 * params the fire resolvers' per-mode branches produced before B3 collapsed them
 * to one virtual call: hitscan → cast ray of `range` with `damage`; projectile →
 * spawn with `shooterV + dir*speed` + the def's ballistics; missile → spawn with
 * its def. Values are read from the live catalogue so the test stays valid under
 * weapon retuning — it locks the FORWARDING, not the numbers.
 */

import { describe, it, expect } from 'vitest';
import { getWeaponObject } from './index.js';
import type { WeaponFireContext, WeaponFireSink } from './Weapon.js';
import {
  getWeapon,
  type HitscanWeaponDef,
  type ProjectileWeaponDef,
  type MissileWeaponDef,
  type WeaponId,
} from '../WeaponCatalogue.js';

function makeCtx(over: Partial<WeaponFireContext> = {}): WeaponFireContext {
  return { fromX: 10, fromY: 20, dirX: 0.6, dirY: 0.8, shooterVx: 5, shooterVy: -3, mountId: 'm0', ...over };
}

class RecordingSink implements WeaponFireSink {
  calls: string[] = [];
  hitscanArgs?: { range: number; damage: number };
  projArgs?: { vx: number; vy: number; damage: number; radius: number; maxTicks: number; weaponId: WeaponId };
  missileDef?: MissileWeaponDef;

  hitscan(_ctx: WeaponFireContext, range: number, damage: number): void {
    this.calls.push('hitscan');
    this.hitscanArgs = { range, damage };
  }
  spawnProjectile(
    _ctx: WeaponFireContext,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    maxTicks: number,
    weaponId: WeaponId,
  ): void {
    this.calls.push('projectile');
    this.projArgs = { vx, vy, damage, radius, maxTicks, weaponId };
  }
  spawnMissile(_ctx: WeaponFireContext, def: MissileWeaponDef): void {
    this.calls.push('missile');
    this.missileDef = def;
  }
}

describe('GEP B3 weapon flyweights — resolveFire parity with the fire-resolver per-mode logic', () => {
  it('HitscanWeapon casts a ray of its range with its damage (== resolver hitscan branch)', () => {
    const sink = new RecordingSink();
    getWeaponObject('hitscan').resolveFire(makeCtx(), sink);
    const def = getWeapon('hitscan') as HitscanWeaponDef;
    expect(sink.calls).toEqual(['hitscan']);
    expect(sink.hitscanArgs).toEqual({ range: def.range, damage: def.damage });
  });

  it('ProjectileWeapon spawns with shooterV + dir*speed + the def ballistics (== resolver projectile branch)', () => {
    const sink = new RecordingSink();
    const ctx = makeCtx();
    getWeaponObject('laser').resolveFire(ctx, sink);
    const def = getWeapon('laser') as ProjectileWeaponDef;
    expect(sink.calls).toEqual(['projectile']);
    expect(sink.projArgs!.vx).toBeCloseTo(ctx.shooterVx + ctx.dirX * def.speed, 9);
    expect(sink.projArgs!.vy).toBeCloseTo(ctx.shooterVy + ctx.dirY * def.speed, 9);
    expect(sink.projArgs!.damage).toBe(def.damage);
    expect(sink.projArgs!.radius).toBe(def.radius);
    expect(sink.projArgs!.maxTicks).toBe(def.maxTicks);
    expect(sink.projArgs!.weaponId).toBe('laser');
  });

  it('MissileWeapon spawns with its exact def (== resolver missile branch)', () => {
    const sink = new RecordingSink();
    getWeaponObject('heat-seeker').resolveFire(makeCtx(), sink);
    const def = getWeapon('heat-seeker') as MissileWeaponDef;
    expect(sink.calls).toEqual(['missile']);
    expect(sink.missileDef).toBe(def);
  });

  it('flyweights are stable singletons (one per id, reused — no per-fire allocation)', () => {
    expect(getWeaponObject('hitscan')).toBe(getWeaponObject('hitscan'));
    expect(getWeaponObject('laser').id).toBe('laser');
    expect(getWeaponObject('heat-seeker').id).toBe('heat-seeker');
  });
});
