import { describe, it, expect } from 'vitest';
import { hitscanFalloffFrac, getWeapon, type HitscanWeaponDef } from './WeaponCatalogue.js';

/**
 * P3.13 — "optimal range + beyond" hitscan damage falloff (LINEAR since Phase 5,
 * 2026-06-14).
 *
 * The R2.29 model tapered damage WITHIN [0, range]. The P3.13 decision moved to
 * FULL damage out to the OPTIMAL range, then a drop-off BEYOND it to
 * `minDamageFrac` at `maxRange`. The Phase-5 playtest correction: that drop-off
 * is **LINEAR**, not reverse-square ("the laser beam falloff should be linear
 * not reverse square"). So `frac = 1 − (1 − minDamageFrac)·t` over the band.
 */
describe('hitscanFalloffFrac (optimal + beyond, linear)', () => {
  it('is FULL (1.0) everywhere within the optimal range, at the muzzle and the edge', () => {
    expect(hitscanFalloffFrac(0, 250, 375, 0.15)).toBeCloseTo(1, 9);
    expect(hitscanFalloffFrac(100, 250, 375, 0.15)).toBeCloseTo(1, 9);
    expect(hitscanFalloffFrac(250, 250, 375, 0.15)).toBeCloseTo(1, 9); // at optimal = still full
  });

  it('falls LINEARLY BEYOND optimal, reaching minDamageFrac at (and past) maxRange', () => {
    // t = (dist − optimal)/(max − optimal); frac = 1 − (1−minFrac)·t.
    // dist 312.5 ⇒ t 0.5 ⇒ 1 − 0.85·0.5 = 0.575.
    expect(hitscanFalloffFrac(312.5, 250, 375, 0.15)).toBeCloseTo(0.575, 9);
    // dist 281.25 ⇒ t 0.25 ⇒ 1 − 0.85·0.25 = 0.7875.
    expect(hitscanFalloffFrac(281.25, 250, 375, 0.15)).toBeCloseTo(0.7875, 9);
    // At and beyond maxRange ⇒ the floor.
    expect(hitscanFalloffFrac(375, 250, 375, 0.15)).toBeCloseTo(0.15, 9);
    expect(hitscanFalloffFrac(500, 250, 375, 0.15)).toBeCloseTo(0.15, 9);
  });

  it('is LINEAR in the falloff band — equal-distance halves drop by the same amount', () => {
    const atOptimal = hitscanFalloffFrac(250, 250, 375, 0.15); // 1
    const atMid = hitscanFalloffFrac(312.5, 250, 375, 0.15); // 0.575
    const atMax = hitscanFalloffFrac(375, 250, 375, 0.15); // 0.15
    const nearDrop = atOptimal - atMid; // 0.425
    const farDrop = atMid - atMax; // 0.425
    expect(farDrop).toBeCloseTo(nearDrop, 9);
  });

  it('degenerate band (maxRange <= optimalRange) ⇒ flat (1.0)', () => {
    expect(hitscanFalloffFrac(300, 250, 250, 0.15)).toBe(1);
    expect(hitscanFalloffFrac(300, 250, 200, 0.15)).toBe(1);
  });

  it('the beam weapon carries an optimal+beyond falloff (so beams use the gradient)', () => {
    const beam = getWeapon('hitscan') as HitscanWeaponDef;
    expect(beam.falloff).toBeDefined();
    expect(beam.falloff!.minDamageFrac).toBeGreaterThanOrEqual(0);
    expect(beam.falloff!.minDamageFrac).toBeLessThan(1);
    // maxRangeMul > 1 ⇒ the beam reaches BEYOND its optimal range with falloff.
    expect(beam.falloff!.maxRangeMul).toBeGreaterThan(1);
  });
});
