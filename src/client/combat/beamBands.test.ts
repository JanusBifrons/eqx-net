/**
 * Campaign 5.2 lock (review A9 fragility / Part D #10) — the drawn beam bands
 * are DERIVED from the weapon catalogue, so a catalogue tuning moves the
 * visual band in lockstep with the server damage band, and a re-introduced
 * parallel client constant fails here.
 */
import { describe, it, expect } from 'vitest';
import { getWeapon, type HitscanWeaponDef, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { mountRangeFactor, weaponIdReach } from '../../core/combat/mountReach.js';
import { getWeaponObject, type WeaponFireContext, type WeaponFireSink } from '../../core/combat/weapons/index.js';
import type { MountSize } from '../../shared-types/shipScale/tuning.js';
import { HITSCAN_RANGE } from '../../core/combat/Weapons.js';
import {
  beamOptimalDist,
  beamMaxDist,
  beamNoHitSolidDist,
  VISUAL_BEAM_SOLID_FRAC,
} from './beamBands.js';

describe('beamBands — catalogue-derived beam draw bands (campaign 5.2)', () => {
  it('the LIVE beam weapon: optimal == catalogue range, max == range × falloff.maxRangeMul', () => {
    const laser = getWeapon('hitscan');
    expect(laser.mode).toBe('hitscan');
    const h = laser as HitscanWeaponDef;
    expect(beamOptimalDist(laser)).toBe(h.range);
    expect(beamMaxDist(laser)).toBeCloseTo(h.range * (h.falloff?.maxRangeMul ?? 1), 6);
    // The band is a real beyond-optimal fringe (the catalogue carries one).
    expect(beamMaxDist(laser)).toBeGreaterThan(beamOptimalDist(laser));
  });

  it('a catalogue tuning MOVES the drawn band (no parallel constant can hold it still)', () => {
    const laser = getWeapon('hitscan') as HitscanWeaponDef;
    const tuned: HitscanWeaponDef = {
      ...laser,
      range: 300,
      falloff: { minDamageFrac: 0.15, maxRangeMul: 2 },
    };
    expect(beamOptimalDist(tuned)).toBe(300);
    expect(beamMaxDist(tuned)).toBe(600); // moves with the def — never a baked 325
  });

  it('a def with no beyond-optimal falloff draws max == optimal (back-compat)', () => {
    const laser = getWeapon('hitscan') as HitscanWeaponDef;
    const flat: HitscanWeaponDef = { ...laser, falloff: undefined };
    expect(beamMaxDist(flat)).toBe(beamOptimalDist(flat));
  });

  it('non-hitscan defs fall back to the legacy HITSCAN_RANGE optimal', () => {
    const seeker = getWeapon('heat-seeker');
    expect(beamOptimalDist(seeker)).toBe(HITSCAN_RANGE);
    expect(beamMaxDist(seeker)).toBe(HITSCAN_RANGE);
  });

  it('the no-hit solid core is the visual fraction of optimal, clamped to the drawn length', () => {
    expect(beamNoHitSolidDist(250, 1000)).toBeCloseTo(250 * VISUAL_BEAM_SOLID_FRAC, 6);
    expect(beamNoHitSolidDist(250, 50)).toBe(50); // clipped short — never past the draw
  });
});

/** The drawn beam's length by mount size (plan partitioned-chasing-lark): a
 *  mining laser's beam ends at its mount's sized reach, the same length as
 *  the server's ray (`HitscanWeapon` with `ctx.rangeMul`) and its fire gate
 *  (`weaponIdReach`). Fails when either side drops the mount size (#15). */
describe('beamBands — beam length by mount size, both sides agree', () => {
  const serverRay = (weaponId: WeaponId, size: MountSize): number => {
    let ray = -1;
    const sink = { hitscan: (_c: unknown, range: number, _d: number, _f?: number, max?: number) => { ray = max ?? range; } } as unknown as WeaponFireSink;
    const ctx: WeaponFireContext = { fromX: 0, fromY: 0, dirX: 0, dirY: 1, shooterVx: 0, shooterVy: 0, mountId: 'm', rangeMul: mountRangeFactor(weaponId, size) };
    getWeaponObject(weaponId).resolveFire(ctx, sink);
    return ray;
  };
  for (const size of ['XL', 'L', 'M', 'S', 'AA'] as const) {
    it(`a ${size} mining laser draws to its sized reach, as far as the server's ray`, () => {
      const drawn = beamMaxDist(getWeapon('mining_laser'), mountRangeFactor('mining_laser', size));
      expect(drawn).toBeCloseTo(weaponIdReach('mining_laser', size), 6);
      expect(drawn).toBeCloseTo(serverRay('mining_laser', size), 6);
      expect(beamOptimalDist(getWeapon('mining_laser'), mountRangeFactor('mining_laser', size))).toBeCloseTo(drawn, 6);
    });
  }
  it('an S mining laser draws well short of the catalogue 12,000 u; a gun keeps its length at every size', () => {
    expect(beamMaxDist(getWeapon('mining_laser'), mountRangeFactor('mining_laser', 'S'))).toBeLessThan(6_000);
    for (const id of ['hitscan', 'heavy_beam'] as const) {
      expect(beamMaxDist(getWeapon(id), mountRangeFactor(id, 'S'))).toBe(beamMaxDist(getWeapon(id)));
      expect(serverRay(id, 'S')).toBeCloseTo(beamMaxDist(getWeapon(id)), 6);
    }
  });
});
