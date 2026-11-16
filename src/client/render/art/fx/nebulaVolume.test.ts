import { describe, it, expect } from 'vitest';
import { BACK_MAX_SPEED, backLayerParallax, FRONT, frontPuffShift } from './nebulaVolume.js';

// Owner 2026-11-16: "near-field parallaxing was too extreme, particularly on
// command mode". Screen speed of each nebula part, as a share of the world's,
// from the flying zoom out to the command view.
const ZOOMS = [2, 1, 0.5, 0.2, 0.05, 0.02, 0.005];

describe('nebula parallax stays sane at every zoom (command view included)', () => {
  it('front puffs slide past at their slice ratio, the same at every zoom, never more than 1.25x the world', () => {
    const P = 1e9; // far from a wrap
    for (const zoom of ZOOMS) {
      for (const p of FRONT) {
        const d = 1000;
        const moved = Math.abs(frontPuffShift(0.5, d, p, zoom, P) - frontPuffShift(0.5, 0, p, zoom, P));
        const ratio = moved / (d * zoom);
        expect(ratio).toBeCloseTo(p, 6);
        expect(ratio).toBeLessThanOrEqual(1.25);
        expect(ratio).toBeGreaterThan(1); // still in front: faster than the world
      }
    }
  });

  it('far cloud layers and knots never outrun the world', () => {
    for (const zoom of ZOOMS) {
      for (const [p, zp] of [[0.22, 0.3], [0.55, 0.6], [0.88, 0.9], [0.5, 0.5]] as const) {
        const ratio = (backLayerParallax(p, zp, zoom) * Math.pow(zoom, zp)) / zoom;
        expect(ratio).toBeLessThanOrEqual(BACK_MAX_SPEED + 1e-9);
      }
    }
    // At the flying zoom the authored depth is unchanged.
    expect(backLayerParallax(0.55, 0.6, 1)).toBe(0.55);
  });
});
