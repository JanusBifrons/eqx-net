import { describe, it, expect } from 'vitest';
import {
  triangulate,
  signedArea,
  shipShapeToPolygon,
  shipCollisionTriangles,
  SHIP_KIND_COLLISION_TRIANGLES,
  type Triangle,
} from './triangulate.js';
import { polygonArea, convexHullCCW, type Vec2 } from '../swarm/asteroidShape.js';
import { SHIP_KINDS, SHIP_KINDS_LIST, DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';

const triArea = (t: Triangle): number => signedArea(t);
const sumArea = (ts: readonly Triangle[]): number => ts.reduce((s, t) => s + triArea(t), 0);

describe('signedArea', () => {
  it('is positive for a CCW polygon, negative for CW', () => {
    const ccw: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    expect(signedArea(ccw)).toBeCloseTo(4, 9);
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-4, 9);
  });
});

describe('triangulate — convex', () => {
  it('tiles a CCW unit square into 2 CCW triangles preserving area', () => {
    const sq: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const tris = triangulate(sq);
    expect(tris).toHaveLength(2);
    for (const t of tris) expect(signedArea(t)).toBeGreaterThan(0); // CCW
    expect(sumArea(tris)).toBeCloseTo(1, 9);
  });

  it('normalises CW input to CCW triangles (ship points are authored CW)', () => {
    const cwSquare: Vec2[] = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
    expect(signedArea(cwSquare)).toBeLessThan(0);
    const tris = triangulate(cwSquare);
    expect(tris).toHaveLength(2);
    for (const t of tris) expect(signedArea(t)).toBeGreaterThan(0);
    expect(sumArea(tris)).toBeCloseTo(1, 9);
  });

  it('returns [] for degenerate (< 3 vertices)', () => {
    expect(triangulate([])).toEqual([]);
    expect(triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });
});

describe('triangulate — concave (the whole point)', () => {
  // Fighter silhouette: a notched arrowhead with a REFLEX vertex at (0,5).
  // A convex hull would fill the tail notch; triangulation must not.
  const fighter = shipShapeToPolygon(SHIP_KINDS.fighter);

  it('respects the concavity: triangle area == true polygon area, NOT the hull area', () => {
    const tris = triangulate(fighter);
    const trueArea = polygonArea(fighter);
    const hullArea = polygonArea(convexHullCCW(fighter));
    expect(hullArea).toBeGreaterThan(trueArea); // proves the shape is concave
    expect(sumArea(tris)).toBeCloseTo(trueArea, 6); // tiles the concave shape exactly
    expect(sumArea(tris)).toBeLessThan(hullArea - 1); // did NOT fill the notch
    for (const t of tris) expect(signedArea(t)).toBeGreaterThan(0);
  });
});

describe('per-kind precomputed collision geometry', () => {
  it('every kind: n-2 CCW triangles that exactly tile the rendered silhouette', () => {
    for (const kind of SHIP_KINDS_LIST) {
      const poly = shipShapeToPolygon(kind);
      const tris = SHIP_KIND_COLLISION_TRIANGLES[kind.id]!;
      expect(tris.length, `${kind.id} triangle count`).toBe(poly.length - 2);
      for (const t of tris) {
        expect(signedArea(t), `${kind.id} triangle CCW`).toBeGreaterThan(0);
      }
      expect(sumArea(tris), `${kind.id} area conserved`).toBeCloseTo(polygonArea(poly), 5);
    }
  });

  it('heavy (convex pentagon) decomposes to a deterministic fan — golden lock', () => {
    // Heavy points (scale 1): p0(0,-14) p1(12,-2) p2(10,14) p3(-10,14) p4(-12,-2),
    // authored CCW. Deterministic ear scan (first convex vertex, index order)
    // ⇒ exactly this fan. A Node↔Chromium float drift or an algorithm change
    // changes this list and fails loudly.
    expect(SHIP_KIND_COLLISION_TRIANGLES.heavy).toEqual([
      [{ x: -12, y: -2 }, { x: 0, y: -14 }, { x: 12, y: -2 }],
      [{ x: -12, y: -2 }, { x: 12, y: -2 }, { x: 10, y: 14 }],
      [{ x: 10, y: 14 }, { x: -10, y: 14 }, { x: -12, y: -2 }],
    ]);
  });

  it('is deterministic: re-running triangulate yields a deeply-equal result', () => {
    for (const kind of SHIP_KINDS_LIST) {
      const poly = shipShapeToPolygon(kind);
      expect(triangulate(poly)).toEqual(triangulate(poly));
    }
  });

  it('shipCollisionTriangles falls back to the default kind on unknown id', () => {
    expect(shipCollisionTriangles('garbage')).toBe(
      SHIP_KIND_COLLISION_TRIANGLES[DEFAULT_SHIP_KIND],
    );
    expect(shipCollisionTriangles(null)).toBe(SHIP_KIND_COLLISION_TRIANGLES[DEFAULT_SHIP_KIND]);
    expect(shipCollisionTriangles('scout')).toBe(SHIP_KIND_COLLISION_TRIANGLES.scout);
  });
});
