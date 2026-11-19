import { describe, it, expect } from 'vitest';
import { getShipKind } from '../shipKinds.js';
import { shipTuning, shieldVisualRadius } from './tuning.js';
import { navBeamClearance, navTurnRoom, navHull } from './navTuning.js';

const CAPITALS = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'];

describe('nav hull numbers (owner 2026-11-19, "width on straights")', () => {
  it('a capital flies straight on its half beam plus the clearance margin; others on their clearance', () => {
    for (const id of CAPITALS) {
      const k = getShipKind(id), t = shipTuning(k);
      expect(navBeamClearance(k)).toBeCloseTo(shieldVisualRadius(k) + t.navClearance - k.radius, 6);
      expect(navBeamClearance(k)).toBeLessThan(t.navClearance / 2);
    }
    const f = getShipKind('fighter');
    expect(navBeamClearance(f)).toBe(shipTuning(f).navClearance);
  });

  it('a turn needs the margin plus the half-width its outline sweeps (locks navTurnRoom to navClearance = radius × 1.25)', () => {
    for (const id of CAPITALS) {
      const k = getShipKind(id), t = shipTuning(k), a = k.radius, b = shieldVisualRadius(k), m = t.navClearance - a;
      const full = t.navClearance, beam = navBeamClearance(k);
      expect(navTurnRoom(full, beam, 0, 1)).toBeCloseTo(beam, 6);
      for (const deg of [10, 30, 45, 60]) {
        const th = (deg * Math.PI) / 180;
        expect(navTurnRoom(full, beam, Math.sin(th), Math.cos(th))).toBeCloseTo(m + Math.min(Math.hypot(a, b), a * Math.sin(th) + b * Math.cos(th)), 6);
      }
      expect(navTurnRoom(full, beam, 1, 0)).toBeCloseTo(m + Math.hypot(a, b), 6);
      expect(navTurnRoom(full, beam, 0, -1)).toBeCloseTo(m + Math.hypot(a, b), 6); // turned right round
    }
  });

  it('navHull is built once per kind', () => {
    const k = getShipKind('battleship');
    expect(navHull(k)).toBe(navHull(k));
    expect(navHull(k)).toEqual({ clearance: shipTuning(k).navClearance, comfort: expect.any(Number), beam: navBeamClearance(k) });
  });
});
