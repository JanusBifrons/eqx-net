/**
 * Campaign 5.2 lock (review A9 fragility / Part D #10) — the drawn beam bands
 * are DERIVED from the weapon catalogue, so a catalogue tuning moves the
 * visual band in lockstep with the server damage band, and a re-introduced
 * parallel client constant fails here.
 */
import { describe, it, expect } from 'vitest';
import { getWeapon, type HitscanWeaponDef } from '../../core/combat/WeaponCatalogue.js';
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
