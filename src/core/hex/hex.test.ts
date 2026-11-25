import { describe, it, expect } from 'vitest';
import {
  HEX_DIRS,
  axialToPixel,
  axialToPixelInto,
  hexCornerInto,
  hexCornersInto,
  hexDistance,
  hexNeighbourInto,
  hexNeighbours,
  hexRing,
  hexSizeFromFlat,
  hexSpiral,
  hexVertices,
  pixelToAxial,
  pixelToAxialInto,
} from './hex.js';

const SIZE = hexSizeFromFlat(1300);

describe('axialToPixel', () => {
  it('keeps the galaxy projection exactly', () => {
    const p = axialToPixel({ q: 2, r: -3 }, 50);
    expect(p.x).toBe(50 * Math.sqrt(3) * (2 + -3 / 2));
    expect(p.y).toBe(50 * (3 / 2) * -3);
  });

  it('Into variant writes the same point into the scratch object', () => {
    const out = { x: 0, y: 0 };
    for (let q = -4; q <= 4; q++) {
      for (let r = -4; r <= 4; r++) {
        expect(axialToPixelInto(q, r, SIZE, out)).toBe(out);
        expect(out).toEqual(axialToPixel({ q, r }, SIZE));
      }
    }
  });

  it('neighbouring centres are one flat width apart', () => {
    for (const d of HEX_DIRS) {
      const p = axialToPixel(d, SIZE);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1300, 6);
    }
  });
});

describe('pixelToAxial', () => {
  it('round-trips every hex centre', () => {
    const out = { q: 0, r: 0 };
    for (let q = -12; q <= 12; q++) {
      for (let r = -12; r <= 12; r++) {
        const p = axialToPixel({ q, r }, SIZE);
        expect(pixelToAxialInto(p.x, p.y, SIZE, out)).toBe(out);
        expect(out).toEqual({ q, r });
      }
    }
  });

  it('maps points just inside each corner and edge to the hex', () => {
    const c = { x: 0, y: 0 };
    const v = { x: 0, y: 0 };
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        axialToPixelInto(q, r, SIZE, c);
        for (let i = 0; i < 6; i++) {
          hexCornerInto(c.x, c.y, SIZE * 0.98, i, v);
          expect(pixelToAxial(v.x, v.y, SIZE)).toEqual({ q, r });
          // Mid-edge, just inside (apothem = SIZE·√3/2).
          const a = Math.PI / 3 + (i * Math.PI) / 3;
          const m = SIZE * (Math.sqrt(3) / 2) * 0.98;
          expect(pixelToAxial(c.x + m * Math.cos(a), c.y + m * Math.sin(a), SIZE)).toEqual({ q, r });
        }
      }
    }
  });

  it('never yields -0', () => {
    const h = pixelToAxial(-1, -1, SIZE);
    expect(Object.is(h.q, -0)).toBe(false);
    expect(Object.is(h.r, -0)).toBe(false);
  });
});

describe('corners', () => {
  it('hexVertices starts at 30° and steps 60°', () => {
    const v = hexVertices(10);
    expect(v).toHaveLength(6);
    expect(v[0]!.x).toBeCloseTo(10 * Math.cos(Math.PI / 6));
    expect(v[0]!.y).toBeCloseTo(5);
    expect(v[1]!.x).toBeCloseTo(0);
    expect(v[1]!.y).toBeCloseTo(10);
  });

  it('hexCornerInto / hexCornersInto match hexVertices offset by the centre', () => {
    const v = hexVertices(SIZE);
    const pt = { x: 0, y: 0 };
    const flat = new Float64Array(14);
    hexCornersInto(100, -50, SIZE, flat, 2);
    for (let i = 0; i < 6; i++) {
      hexCornerInto(100, -50, SIZE, i, pt);
      expect(pt.x).toBeCloseTo(100 + v[i]!.x, 9);
      expect(pt.y).toBeCloseTo(-50 + v[i]!.y, 9);
      expect(flat[2 + 2 * i]).toBeCloseTo(pt.x, 9);
      expect(flat[3 + 2 * i]).toBeCloseTo(pt.y, 9);
    }
  });

  it('edge i faces HEX_DIRS[i] (edge midpoint points at the neighbour)', () => {
    const v = hexVertices(SIZE);
    for (let i = 0; i < 6; i++) {
      const a = v[i]!;
      const b = v[(i + 1) % 6]!;
      const n = axialToPixel(HEX_DIRS[i]!, SIZE);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      expect(mx * 2).toBeCloseTo(n.x, 6);
      expect(my * 2).toBeCloseTo(n.y, 6);
    }
  });
});

describe('distance, neighbours, rings', () => {
  it('hexDistance matches the step count', () => {
    expect(hexDistance(0, 0, 0, 0)).toBe(0);
    for (const d of HEX_DIRS) expect(hexDistance(0, 0, d.q, d.r)).toBe(1);
    expect(hexDistance(0, 0, 2, 1)).toBe(3);
    expect(hexDistance(0, 0, -1, 3)).toBe(3);
    expect(hexDistance(0, 0, 3, -2)).toBe(3);
    expect(hexDistance(1, 1, 4, -3)).toBe(4);
    expect(hexDistance(-2, 5, 3, -1)).toBe(hexDistance(3, -1, -2, 5));
  });

  it('neighbours are all at distance 1 and distinct', () => {
    const ns = hexNeighbours({ q: 3, r: -2 });
    const out = { q: 0, r: 0 };
    expect(new Set(ns.map((h) => `${h.q},${h.r}`)).size).toBe(6);
    ns.forEach((h, i) => {
      expect(hexDistance(3, -2, h.q, h.r)).toBe(1);
      expect(hexNeighbourInto(3, -2, i, out)).toEqual(h);
    });
  });

  it('ring k has 6k distinct hexes all at distance k; spiral counts 1+3k(k+1)', () => {
    const c = { q: -2, r: 4 };
    for (let k = 0; k <= 5; k++) {
      const ring = hexRing(c, k);
      expect(ring).toHaveLength(k === 0 ? 1 : 6 * k);
      expect(new Set(ring.map((h) => `${h.q},${h.r}`)).size).toBe(ring.length);
      for (const h of ring) expect(hexDistance(c.q, c.r, h.q, h.r)).toBe(k);
    }
    const sp = hexSpiral(c, 4);
    expect(sp).toHaveLength(1 + 3 * 4 * 5);
    expect(new Set(sp.map((h) => `${h.q},${h.r}`)).size).toBe(sp.length);
  });
});
