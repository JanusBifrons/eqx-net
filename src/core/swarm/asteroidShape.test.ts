import { describe, it, expect } from 'vitest';
import {
  generateAsteroidVertices,
  mulberry32,
  polygonArea,
  verticesToFloat32,
  type Vec2,
} from './asteroidShape.js';
import {
  ASTEROID_VERTEX_COUNT_MAX,
  ASTEROID_VERTEX_RADIAL_MIN,
  ASTEROID_VERTEX_RADIAL_MAX,
} from './asteroidConstants.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
  });

  it('produces values in [0, 1)', () => {
    const prng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = prng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateAsteroidVertices', () => {
  it('is deterministic — same (entityId, radius) yields identical arrays', () => {
    const a = generateAsteroidVertices(42, 24);
    const b = generateAsteroidVertices(42, 24);
    expect(a).toEqual(b);
  });

  it('different entityIds produce different shapes', () => {
    const a = generateAsteroidVertices(42, 24);
    const b = generateAsteroidVertices(43, 24);
    expect(a).not.toEqual(b);
  });

  it('vertex count is bounded by configured upper limit and stays a valid polygon', () => {
    // Convex-hull post-pass may drop deeply-recessed samples, so the actual
    // vertex count can be lower than ASTEROID_VERTEX_COUNT_MIN. The hull is
    // always a valid polygon (≥ 3) and never grows.
    for (let id = 0; id < 200; id++) {
      const verts = generateAsteroidVertices(id, 24);
      expect(verts.length).toBeGreaterThanOrEqual(3);
      expect(verts.length).toBeLessThanOrEqual(ASTEROID_VERTEX_COUNT_MAX);
    }
  });

  it('every vertex sits within the radial bounds', () => {
    const r = 32;
    for (let id = 0; id < 200; id++) {
      const verts = generateAsteroidVertices(id, r);
      for (const v of verts) {
        const len = Math.hypot(v.x, v.y);
        expect(len).toBeGreaterThanOrEqual(r * ASTEROID_VERTEX_RADIAL_MIN - 1e-6);
        expect(len).toBeLessThanOrEqual(r * ASTEROID_VERTEX_RADIAL_MAX + 1e-6);
      }
    }
  });

  it('is convex — every adjacent vertex triple has positive cross product', () => {
    for (let id = 0; id < 200; id++) {
      const verts = generateAsteroidVertices(id, 24);
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const a = verts[i]!;
        const b = verts[(i + 1) % n]!;
        const c = verts[(i + 2) % n]!;
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        expect(cross).toBeGreaterThan(0);
      }
    }
  });

  it('scales linearly with target radius', () => {
    const small = generateAsteroidVertices(99, 10);
    const large = generateAsteroidVertices(99, 40);
    expect(small.length).toBe(large.length);
    for (let i = 0; i < small.length; i++) {
      expect(large[i]!.x).toBeCloseTo(small[i]!.x * 4, 5);
      expect(large[i]!.y).toBeCloseTo(small[i]!.y * 4, 5);
    }
  });

  it('pinned regression — generateAsteroidVertices(42, 24) is bit-stable', () => {
    // Catches PRNG drift across runtimes / refactors. If the generator output
    // changes intentionally, regenerate this snapshot AND bump anything that
    // assumed shape continuity (e.g. persisted snapshots).
    const verts = generateAsteroidVertices(42, 24);
    const flat = verts.flatMap((v) => [v.x, v.y]);
    // Two-decimal precision is enough to pin shape topology while tolerating
    // future float-formatting cosmetics; if PRNG output drifts these will
    // diverge wildly, not subtly.
    expect(flat.map((n) => Math.round(n * 100) / 100)).toMatchSnapshot();
  });
});

describe('verticesToFloat32', () => {
  it('flattens a vertex list into [x0,y0,x1,y1,...]', () => {
    const verts: Vec2[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
    const flat = verticesToFloat32(verts);
    expect(Array.from(flat)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('polygonArea', () => {
  it('computes area of a unit square', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(polygonArea(square)).toBeCloseTo(1, 9);
  });

  it('is sign-invariant — CW input has the same magnitude as CCW', () => {
    const ccw: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 3 }];
    const cw: Vec2[] = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 2, y: 0 }];
    expect(polygonArea(ccw)).toBeCloseTo(3, 9);
    expect(polygonArea(cw)).toBeCloseTo(3, 9);
  });

  it('returns 0 for degenerate inputs', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([{ x: 0, y: 0 }])).toBe(0);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(0);
  });

  it('approximates πr² for a generated asteroid', () => {
    const r = 32;
    const verts = generateAsteroidVertices(7, r);
    const area = polygonArea(verts);
    const circleArea = Math.PI * r * r;
    // Polygon fits inside [0.70, 1.00]·r — area must lie between
    // (radial_min)²·circleArea (0.49) and circleArea, and a 6–9-vertex
    // polygon never reaches the full circle.
    expect(area).toBeGreaterThan(circleArea * 0.4);
    expect(area).toBeLessThan(circleArea * 1.0);
  });
});
