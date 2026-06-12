import { describe, it, expect } from 'vitest';
import { hitscanFalloffFrac, getWeapon, type HitscanWeaponDef } from './WeaponCatalogue.js';

/** R2.29 — reverse-square hitscan damage falloff. */
describe('hitscanFalloffFrac', () => {
  it('is 1.0 at point-blank and minDamageFrac at (and beyond) max range', () => {
    expect(hitscanFalloffFrac(0, 250, 0.4)).toBeCloseTo(1, 9);
    expect(hitscanFalloffFrac(250, 250, 0.4)).toBeCloseTo(0.4, 9);
    // Clamped beyond range — never below the floor.
    expect(hitscanFalloffFrac(500, 250, 0.4)).toBeCloseTo(0.4, 9);
  });

  it('falls as the SQUARE of normalized distance (hand-derived)', () => {
    // t = 0.5 ⇒ 1 - (1-0.4)·0.25 = 1 - 0.15 = 0.85.
    expect(hitscanFalloffFrac(125, 250, 0.4)).toBeCloseTo(0.85, 9);
    // t = 0.25 ⇒ 1 - 0.6·0.0625 = 0.9625.
    expect(hitscanFalloffFrac(62.5, 250, 0.4)).toBeCloseTo(0.9625, 9);
    // Convex: the drop in the FAR half exceeds the drop in the NEAR half.
    const nearDrop = hitscanFalloffFrac(0, 250, 0.4) - hitscanFalloffFrac(125, 250, 0.4);
    const farDrop = hitscanFalloffFrac(125, 250, 0.4) - hitscanFalloffFrac(250, 250, 0.4);
    expect(farDrop).toBeGreaterThan(nearDrop);
  });

  it('degenerate range ⇒ flat (1.0)', () => {
    expect(hitscanFalloffFrac(100, 0, 0.4)).toBe(1);
  });

  it('the beam weapon carries a falloff (so beams actually use the gradient)', () => {
    const beam = getWeapon('hitscan') as HitscanWeaponDef;
    expect(beam.falloff).toBeDefined();
    expect(beam.falloff!.minDamageFrac).toBeGreaterThan(0);
    expect(beam.falloff!.minDamageFrac).toBeLessThan(1);
  });
});
