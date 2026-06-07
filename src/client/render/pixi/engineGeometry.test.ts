import { describe, it, expect } from 'vitest';
import { engineProfileForKind } from './engineGeometry';
import { getShipKind, DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds';

describe('engineProfileForKind', () => {
  it('derives sternOffset from the hull rear extent (fighter rear edge = y 10)', () => {
    // FIGHTER points: [[0,-16],[-10,10],[0,5],[10,10]] → max +y = 10, scale 1.
    const p = engineProfileForKind('fighter');
    expect(p.sternOffset).toBeCloseTo(10, 6);
  });

  it('scout has a smaller rear extent than fighter (y 8 vs 10)', () => {
    expect(engineProfileForKind('scout').sternOffset).toBeLessThan(
      engineProfileForKind('fighter').sternOffset,
    );
  });

  it('plumeScale is 1 for the reference fighter and scales with hull radius', () => {
    expect(engineProfileForKind('fighter').plumeScale).toBeCloseTo(1, 6);
    // scout radius 10 < fighter radius 12 → thinner plume.
    expect(engineProfileForKind('scout').plumeScale).toBeLessThan(1);
    // heavy is a larger chassis → fatter plume.
    const heavyRadius = getShipKind('heavy').radius;
    const fighterRadius = getShipKind('fighter').radius;
    if (heavyRadius > fighterRadius) {
      expect(engineProfileForKind('heavy').plumeScale).toBeGreaterThan(1);
    }
  });

  it('is well-defined (positive offset + scale) for every catalogue kind', () => {
    for (const id of ['fighter', 'scout', 'heavy', 'interceptor', 'gunship', 'missile-frigate']) {
      const p = engineProfileForKind(id);
      expect(p.sternOffset).toBeGreaterThan(0);
      expect(p.plumeScale).toBeGreaterThan(0);
    }
  });

  it('falls back to the default kind for unknown / missing ids', () => {
    const dflt = engineProfileForKind(DEFAULT_SHIP_KIND);
    expect(engineProfileForKind(undefined)).toEqual(dflt);
    expect(engineProfileForKind('not-a-real-kind')).toEqual(dflt);
  });
});
