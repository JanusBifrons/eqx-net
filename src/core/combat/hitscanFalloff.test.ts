import { describe, it, expect } from 'vitest';
import { hitscanFalloffFrac, getWeapon, type HitscanWeaponDef } from './WeaponCatalogue.js';

/**
 * Equinox laser issue — "optimal range + beyond" hitscan damage falloff, now
 * LINEAR (plan `i-d-like-you-to-typed-cray`, 2026-06-14).
 *
 * Model: FULL damage out to the OPTIMAL range, then a **linear** drop-off BEYOND
 * it to `minDamageFrac` at `maxRange`. The user's decision was to switch the
 * beyond-optimal curve from reverse-square to LINEAR — a constant fall per unit
 * of over-range distance, so the falloff reads as a smooth, predictable taper
 * (matching the visual beam taper) rather than the reverse-square's "slow then
 * cliff" shape that felt like damage "drops to 0 almost instantly beyond range".
 *
 * The curve is `(dist, optimalRange, maxRange, minDamageFrac)`:
 *   t = (dist − optimal)/(max − optimal);  frac = 1 − (1 − minFrac)·t.
 */
describe('hitscanFalloffFrac (optimal + LINEAR beyond)', () => {
  it('is FULL (1.0) everywhere within the optimal range, at the muzzle and the edge', () => {
    expect(hitscanFalloffFrac(0, 250, 375, 0.15)).toBeCloseTo(1, 9);
    expect(hitscanFalloffFrac(100, 250, 375, 0.15)).toBeCloseTo(1, 9);
    expect(hitscanFalloffFrac(250, 250, 375, 0.15)).toBeCloseTo(1, 9); // at optimal = still full
  });

  it('falls LINEARLY beyond optimal, reaching minDamageFrac at (and past) maxRange', () => {
    // t = (dist − optimal)/(max − optimal); frac = 1 − (1−minFrac)·t.
    // dist 312.5 ⇒ t 0.5 ⇒ 1 − 0.85·0.5 = 0.575.
    expect(hitscanFalloffFrac(312.5, 250, 375, 0.15)).toBeCloseTo(0.575, 9);
    // dist 281.25 ⇒ t 0.25 ⇒ 1 − 0.85·0.25 = 0.7875.
    expect(hitscanFalloffFrac(281.25, 250, 375, 0.15)).toBeCloseTo(0.7875, 9);
    // dist 343.75 ⇒ t 0.75 ⇒ 1 − 0.85·0.75 = 0.3625.
    expect(hitscanFalloffFrac(343.75, 250, 375, 0.15)).toBeCloseTo(0.3625, 9);
    // At and beyond maxRange ⇒ the floor.
    expect(hitscanFalloffFrac(375, 250, 375, 0.15)).toBeCloseTo(0.15, 9);
    expect(hitscanFalloffFrac(500, 250, 375, 0.15)).toBeCloseTo(0.15, 9);
  });

  it('is LINEAR in the falloff band — equal distances drop equal amounts (no convex cliff)', () => {
    const atOptimal = hitscanFalloffFrac(250, 250, 375, 0.15); // 1
    const atMid = hitscanFalloffFrac(312.5, 250, 375, 0.15); // 0.575
    const atMax = hitscanFalloffFrac(375, 250, 375, 0.15); // 0.15
    const nearDrop = atOptimal - atMid; // 0.425
    const farDrop = atMid - atMax; // 0.425
    // The defining property of LINEAR (vs the old reverse-square, where the far
    // half dropped MORE than the near half): equal-width sub-bands drop equally.
    expect(nearDrop).toBeCloseTo(farDrop, 9);
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
