/**
 * GPU-lit ship art (R&D): the maps hold what the light pass needs, and the
 * shader's maths (its TypeScript twin, `shadeLitTexel`) gives the same
 * picture as today's baked frames. Measured per texel on real ships.
 */
import { describe, it, expect } from 'vitest';
import { forgeShip } from './fields.js';
import { shipPpu, SUN_STEPS } from './bake.js';
import { DEFAULT_RIG, litFrame, frameBytes } from './shade.js';
import { encodeLitMaps, litFrameFromMaps, litMapsBytes } from './litMaps.js';

const SHIPS = ['fighter', 'missile-frigate', 'robot-hexagon'];

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): { mean: number; p99: number } {
  const ds: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3]! === 0) continue;
    ds.push(Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)));
  }
  ds.sort((x, y) => x - y);
  return { mean: ds.reduce((s, v) => s + v, 0) / ds.length, p99: ds[Math.floor(ds.length * 0.99)]! };
}

describe('GPU-lit ship maps', () => {
  for (const id of SHIPS) {
    it(`${id}: the maps lit match the baked frames`, () => {
      const f = forgeShip(id, { ppu: shipPpu(id) });
      const m = encodeLitMaps(f);
      for (const az of [0.3, 2.1, 4.4]) {
        const noSh = diff(litFrame(f, DEFAULT_RIG, az, false).data, litFrameFromMaps(m, DEFAULT_RIG, az, 0).data);
        const sh = diff(litFrame(f, DEFAULT_RIG, az, true).data, litFrameFromMaps(m, DEFAULT_RIG, az, 64).data);
        // Measured 2026-11-08: mean 0.8-1.1, p99 2-4 (8-bit levels).
        expect(noSh.mean).toBeLessThan(2); expect(noSh.p99).toBeLessThanOrEqual(6);
        expect(sh.mean).toBeLessThan(2); expect(sh.p99).toBeLessThanOrEqual(6);
      }
    });
  }

  it('memory: the maps cost about 3/16 of the 16 baked frames', () => {
    const f = forgeShip('fighter', { ppu: shipPpu('fighter') });
    const baked: ReturnType<typeof litFrame>[] = [];
    for (let k = 0; k < SUN_STEPS; k++) baked.push(litFrame(f, DEFAULT_RIG, (k / SUN_STEPS) * Math.PI * 2));
    const ratio = litMapsBytes(encodeLitMaps(f)) / frameBytes(baked);
    // Measured: 0.19 (three slices + gutters vs sixteen frames).
    expect(ratio).toBeLessThan(0.21);
  });
});
