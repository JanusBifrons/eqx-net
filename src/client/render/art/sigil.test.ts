/**
 * Faction sigils: procedural emblems the forge stamps onto a hull's largest
 * clear flat area. Locks:
 *  - a design is the same every time for a seed;
 *  - the emblem is mirror-symmetric about u = 0 (hulls are);
 *  - nothing is drawn outside the unit circle;
 *  - seeds give visibly different emblems;
 *  - at 16 texels across the mark is neither a speck nor a blob;
 *  - largestClearCircle finds the widest clear spot, preferring the centreline.
 */
import { describe, it, expect } from 'vitest';
import { hashStr } from './raster.js';
import { largestClearCircle, sigilChevron, sigilCoverage, sigilDesign, type SigilDesign } from './sigil.js';

const SEEDS = Array.from({ length: 64 }, (_, i) => hashStr('faction-' + i));

/** Coverage sampled at texel centres over a D×D grid spanning [-1, 1]². */
function raster(f: (u: number, v: number, px: number) => number, D: number): Float32Array {
  const out = new Float32Array(D * D), px = 2 / D;
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) out[y * D + x] = f(((x + 0.5) / D) * 2 - 1, 1 - ((y + 0.5) / D) * 2, px);
  }
  return out;
}
const cov = (d: SigilDesign) => (u: number, v: number, px: number) => sigilCoverage(d, u, v, px);

describe('sigilDesign', () => {
  it('is deterministic per seed', () => {
    for (const s of SEEDS.slice(0, 8)) expect(sigilDesign(s)).toEqual(sigilDesign(s));
  });

  it('keeps fold within 3..6 and the glyph a 4-bit code', () => {
    for (const s of SEEDS) {
      const d = sigilDesign(s);
      expect(d.fold).toBeGreaterThanOrEqual(3);
      expect(d.fold).toBeLessThanOrEqual(6);
      expect(d.glyph).toBeGreaterThanOrEqual(0);
      expect(d.glyph).toBeLessThan(16);
    }
  });
});

describe('sigilCoverage', () => {
  it('is mirror-symmetric about u = 0', () => {
    for (const s of SEEDS) {
      const d = sigilDesign(s);
      for (let j = 0; j <= 40; j++) {
        for (let i = 0; i <= 40; i++) {
          const u = i / 40, v = j / 20 - 1;
          expect(sigilCoverage(d, u, v, 0.05)).toBe(sigilCoverage(d, -u, v, 0.05));
        }
      }
    }
  });

  it('draws nothing outside the unit circle, at any texel size', () => {
    for (const s of SEEDS) {
      const d = sigilDesign(s);
      for (const px of [2 / 12, 2 / 16, 2 / 40]) {
        for (let k = 0; k < 360; k += 3) {
          const a = (k * Math.PI) / 180;
          for (const r of [1.0001, 1.05, 1.4]) expect(sigilCoverage(d, r * Math.sin(a), r * Math.cos(a), px)).toBe(0);
        }
      }
    }
  });

  it('gives visibly different emblems for different seeds', () => {
    const hashes = new Set<string>();
    for (const s of SEEDS.slice(0, 16)) {
      const m = raster(cov(sigilDesign(s)), 24);
      hashes.add(Array.from(m, (c) => (c > 0.5 ? '1' : '0')).join(''));
    }
    expect(hashes.size).toBeGreaterThanOrEqual(8);
  });

  it('reads at 16 texels across: 15%..70% of the disc filled', () => {
    const D = 16;
    for (const s of SEEDS) {
      const m = raster(cov(sigilDesign(s)), D);
      let inDisc = 0, filled = 0;
      for (let y = 0; y < D; y++) {
        for (let x = 0; x < D; x++) {
          const u = ((x + 0.5) / D) * 2 - 1, v = ((y + 0.5) / D) * 2 - 1;
          if (u * u + v * v > 1) continue;
          inDisc++;
          if (m[y * D + x]! > 0.5) filled++;
        }
      }
      const frac = filled / inDisc;
      expect(frac, `seed ${s} ${JSON.stringify(sigilDesign(s))}`).toBeGreaterThanOrEqual(0.15);
      expect(frac, `seed ${s}`).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('sigilChevron', () => {
  it('is a mirror-symmetric mark inside the unit circle, pointing at the nose', () => {
    const m = raster(sigilChevron, 16);
    let filled = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(m[y * 16 + x]).toBe(m[y * 16 + 15 - x]);
        if (m[y * 16 + x]! > 0.5) filled++;
      }
    }
    expect(filled).toBeGreaterThan(256 * 0.15);
    expect(sigilChevron(0, 0.5, 0.1)).toBeGreaterThan(0.9); // apex on the centreline, nose side
    expect(sigilChevron(0, -0.6, 0.1)).toBe(0); // open below
    expect(sigilChevron(0, 1.01, 0.1)).toBe(0);
  });
});

describe('largestClearCircle', () => {
  /** Distance (texels) to the edge of a disc centred (cx, cy), radius R; 0 outside. */
  function discField(w: number, h: number, discs: Array<[number, number, number]>): Float32Array {
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = 0;
        for (const [cx, cy, R] of discs) best = Math.max(best, R - Math.hypot(x - cx, y - cy));
        f[y * w + x] = best;
      }
    }
    return f;
  }

  it('finds a known circle', () => {
    const w = 64, h = 48;
    const dist = discField(w, h, [[40, 20, 12], [10, 36, 5]]);
    const mask = new Uint8Array(w * h).fill(1);
    const c = largestClearCircle(dist, mask, w, h);
    expect(Math.hypot(c.x - 40, c.y - 20)).toBeLessThanOrEqual(1.5);
    expect(c.r).toBeGreaterThanOrEqual(10.8);
  });

  it('respects the mask (array or predicate)', () => {
    const w = 64, h = 48;
    const dist = discField(w, h, [[40, 20, 12], [10, 36, 5]]);
    const mask = new Uint8Array(w * h).fill(1);
    for (let i = 0; i < w * h; i++) if (i % w >= 26) mask[i] = 0;
    const a = largestClearCircle(dist, mask, w, h);
    expect(a.x).toBeLessThan(26);
    expect(Math.hypot(a.x - 10, a.y - 36)).toBeLessThanOrEqual(1.5);
    const b = largestClearCircle(dist, (i) => i % w < 26, w, h);
    expect(b).toEqual(a);
    expect(largestClearCircle(dist, () => false, w, h).r).toBe(0);
  });

  it('prefers the centreline when the best spots are within 10%', () => {
    const w = 65, h = 40;
    // Off-centre disc slightly larger than the centred one.
    const dist = discField(w, h, [[52, 20, 10.5], [32, 20, 10]]);
    const c = largestClearCircle(dist, new Uint8Array(w * h).fill(1), w, h);
    expect(c.x).toBe(32);
    expect(c.y).toBe(20);
    // ...but not when the off-centre spot is clearly larger.
    const dist2 = discField(w, h, [[52, 20, 14], [32, 20, 8]]);
    // (Within the 10% band it may still drift a texel toward the centreline.)
    expect(Math.abs(largestClearCircle(dist2, new Uint8Array(w * h).fill(1), w, h).x - 52)).toBeLessThanOrEqual(1.5);
  });
});
