/**
 * The sun cross-fade (plan iridescent-seeking-rainbow, A3): a Machined ship
 * shows the two baked sun frames nearest the sun's direction in its own
 * frame, the second at the fractional weight, and the light slides without
 * jumping as the ship turns.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { applySunBlend, sunFrameBlend, type SunBlend } from './machinedShipLight.js';

const out = (): SunBlend => ({ j0: 0, j1: 0, t: 0 });
const TAU = Math.PI * 2;

describe('sunFrameBlend', () => {
  it('lands exactly on a baked frame when the angle matches one', () => {
    // Frame k is baked with the sun at local azimuth k/16 · 2π.
    for (let k = 0; k < 16; k++) {
      const b = sunFrameBlend((k / 16) * TAU, 0, 16, out());
      expect(b.j0).toBe(k);
      expect(b.t).toBeCloseTo(0, 9);
    }
  });

  it('the sun stays put in the world: turning the ship moves it the other way in the ship\'s frame', () => {
    const a = sunFrameBlend(0.5, 0, 16, out());
    const b = sunFrameBlend(0.5 + 0.3, 0.3, 16, out());
    expect([b.j0, b.t]).toEqual([a.j0, expect.closeTo(a.t, 9)]);
  });

  it('weights and frames are always in range, and wrap', () => {
    fc.assert(fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), (sun, rot) => {
      const b = sunFrameBlend(sun, rot, 16, out());
      return b.j0 >= 0 && b.j0 < 16 && b.j1 === (b.j0 + 1) % 16 && b.t >= 0 && b.t < 1;
    }));
  });

  it('the light never jumps: a tiny turn changes the blend a tiny amount', () => {
    fc.assert(fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (rot) => {
      const shown = (r: number): number => { const b = sunFrameBlend(0.2, r, 16, out()); return b.j0 + b.t; };
      let d = Math.abs(shown(rot + 1e-4) - shown(rot));
      d = Math.min(d, 16 - d); // across the wrap
      return d < 0.01;
    }));
  });
});

describe('applySunBlend', () => {
  it('points the layers at the two frames with the right alpha', () => {
    const frames = Array.from({ length: 16 }, (_, i) => `f${i}`);
    const layers = { a: { texture: '' }, b: { texture: '', alpha: 0 } };
    applySunBlend(layers, frames, (2.25 / 16) * TAU, 0);
    expect(layers.a.texture).toBe('f2');
    expect(layers.b.texture).toBe('f3');
    expect(layers.b.alpha).toBeCloseTo(0.25, 6);
  });
});
