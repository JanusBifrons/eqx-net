/**
 * Capital ships grounded in WW2 warships (R&D, plan eager-sauteeing-curry).
 * Locks the research ratios (docs/research/ww2-surface-combatants.md) and the
 * solver: the physics fields it produces must actually reach the targets, so
 * a physics change can't silently break "a battleship takes N s to reach
 * full speed".
 */
import { describe, expect, it } from 'vitest';
import {
  CAPITAL_CLASS_IDS, CAPITAL_MAPPINGS, capitalRatios, capitalTargets, mountSizeForCalibre, solveCapitalPhysics, speedAfter,
} from '../../src/shared-types/shipScale/capitalReference.js';

describe('WW2 reference ratios (the research doc table)', () => {
  const expected: Record<string, { length: number; mass: number; pw: number }> = {
    destroyer: { length: 1, mass: 1, pw: 1 },
    'light-cruiser': { length: 1.62, mass: 4.83, pw: 0.345 },
    'heavy-cruiser': { length: 1.79, mass: 5.81, pw: 0.344 },
    battlecruiser: { length: 2.15, mass: 11.71, pw: 0.214 },
    battleship: { length: 2.36, mass: 19.68, pw: 0.179 },
  };
  for (const id of CAPITAL_CLASS_IDS) {
    it(`${id} matches the doc`, () => {
      const r = capitalRatios(id);
      expect(r.length).toBeCloseTo(expected[id]!.length, 2);
      expect(r.mass).toBeCloseTo(expected[id]!.mass, 1);
      expect(r.powerToWeight).toBeCloseTo(expected[id]!.pw, 2);
      // Top speed is nearly flat across classes (27–37 kn in the real fleets).
      expect(r.speed).toBeGreaterThan(0.85);
      expect(r.speed).toBeLessThanOrEqual(1);
    });
  }

  it('turning circles are similar in metres, far tighter in ship lengths for big ships', () => {
    const dd = capitalRatios('destroyer'), bb = capitalRatios('battleship');
    expect(dd.tacticalDiameterM).toBeCloseTo(869, 0);
    expect(bb.tacticalDiameterM).toBeCloseTo(744, 0);
    expect(dd.tacticalDiameterM / 114.7).toBeGreaterThan(7);
    expect(bb.tacticalDiameterM / 270.4).toBeLessThan(3);
  });

  it('main battery calibre maps to mount size: destroyer S, cruisers M, battlecruiser L, battleship XL', () => {
    expect(CAPITAL_CLASS_IDS.map((id) => capitalTargets(id, CAPITAL_MAPPINGS.B).mainMountSize)).toEqual(['S', 'M', 'M', 'L', 'XL']);
    expect(mountSizeForCalibre(5)).toBe('S');
    expect(mountSizeForCalibre(18.1)).toBe('XL');
  });
});

describe.each(['A', 'B', 'C'] as const)('mapping %s — the solved physics reaches its targets', (m) => {
  const anchors = CAPITAL_MAPPINGS[m];
  for (const id of CAPITAL_CLASS_IDS) {
    it(id, () => {
      const t = capitalTargets(id, anchors);
      const p = solveCapitalPhysics(t);
      // 90% of top speed at the target time (±1 tick), and top speed is set
      // by damping, not the clamp.
      expect(speedAfter(p, t.accelSeconds) / t.topSpeed).toBeCloseTo(0.9, 1);
      expect(speedAfter(p, t.accelSeconds * 0.8) / t.topSpeed).toBeLessThan(0.9);
      expect(speedAfter(p, 600) / t.topSpeed).toBeCloseTo(1, 2);
      // Turning: the terminal rate (torque vs inertia + angular damping) is
      // top speed / turning radius, reached to 90% at the response time.
      const I = 0.5 * p.mass * p.radius * p.radius;
      const rate = t.topSpeed / (t.turnDiameter / 2);
      let w = 0;
      for (let i = 0; i < Math.round(t.turnResponseSeconds * 60); i++) w = (w + p.turnTorque / I) / (1 + p.angularDamping / 60);
      expect(w / rate).toBeCloseTo(0.9, 1);
      expect(p.maxAngvel).toBeGreaterThan(rate);
    });
  }

  it('a battleship takes ~5.6× as long as a destroyer to reach speed, at ~90% of its top speed', () => {
    const dd = capitalTargets('destroyer', anchors), bb = capitalTargets('battleship', anchors);
    expect(bb.accelSeconds / dd.accelSeconds).toBeCloseTo(5.6, 0);
    expect(bb.topSpeed / dd.topSpeed).toBeCloseTo(0.9, 1);
    expect(bb.turnResponseSeconds / dd.turnResponseSeconds).toBeCloseTo(Math.sqrt(19.68), 1);
  });
});
