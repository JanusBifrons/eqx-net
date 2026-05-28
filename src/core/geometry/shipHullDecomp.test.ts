import { describe, it, expect } from 'vitest';
import {
  signedArea,
  shipShapeToPolygon,
  shipCollisionParts,
  SHIP_KIND_COLLISION_PARTS,
  type ConvexPart,
} from './shipHullDecomp.js';
import { polygonArea, convexHullCCW, type Vec2 } from '../swarm/asteroidShape.js';
import { SHIP_KINDS, SHIP_KINDS_LIST, DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';

const partArea = (p: ConvexPart): number => signedArea(p);
const sumArea = (ps: readonly ConvexPart[]): number => ps.reduce((s, p) => s + partArea(p), 0);

/** Cross product z-component for (b-a) × (c-b). Positive ⇒ left turn (CCW). */
const cross = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

/** A convex CCW polygon has all left turns (cross > 0) at every vertex. */
function isConvexCcw(poly: ConvexPart): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n]!;
    const b = poly[i]!;
    const c = poly[(i + 1) % n]!;
    if (cross(a, b, c) <= 0) return false;
  }
  return true;
}

describe('signedArea', () => {
  it('is positive for a CCW polygon, negative for CW', () => {
    const ccw: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    expect(signedArea(ccw)).toBeCloseTo(4, 9);
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-4, 9);
  });
});

describe('shipCollisionParts — per-kind structural invariants', () => {
  it.each(SHIP_KINDS_LIST.map((k) => [k.id, k]))(
    '%s: every part is convex, CCW, and area-conserving',
    (_id, kind) => {
      const poly = shipShapeToPolygon(kind);
      const parts = SHIP_KIND_COLLISION_PARTS[kind.id]!;
      expect(parts.length, `${kind.id} part count must be > 0`).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part.length, `${kind.id} part vertex count`).toBeGreaterThanOrEqual(3);
        expect(signedArea(part), `${kind.id} part CCW`).toBeGreaterThan(0);
        expect(isConvexCcw(part), `${kind.id} part is convex`).toBe(true);
      }
      // Area conservation — every concave triangulator's load-bearing
      // property. Sum of decomposed part areas must equal the source
      // polygon area within float tolerance.
      expect(sumArea(parts), `${kind.id} area conserved`).toBeCloseTo(polygonArea(poly), 4);
    },
  );
});

describe('concavity is preserved (not filled)', () => {
  it('Fighter notch is honoured: total decomposed area < convex hull area', () => {
    // Fighter silhouette: notched arrowhead with reflex at (0, 5). A naive
    // ColliderDesc.convexHull(fighter.points) would fill the notch — the
    // decomposed parts must add up to LESS than the convex hull area.
    const fighter = shipShapeToPolygon(SHIP_KINDS.fighter);
    const parts = SHIP_KIND_COLLISION_PARTS.fighter!;
    const trueArea = polygonArea(fighter);
    const hullArea = polygonArea(convexHullCCW(fighter));
    expect(hullArea, 'fighter is concave (sanity)').toBeGreaterThan(trueArea);
    expect(sumArea(parts), 'fighter parts cover the true silhouette').toBeCloseTo(trueArea, 4);
    expect(sumArea(parts), 'fighter parts do NOT fill the notch').toBeLessThan(hullArea - 1);
  });

  it('Crossguard T decomposes into ≥ 2 convex parts (the whole point)', () => {
    // The T-shape has TWO reflex vertices at (±4, -8) post-scale, where the
    // crossbar bottom meets the stem sides. Any sound decomposition must
    // split the T into multiple convex pieces — typically a horizontal
    // crossbar rectangle + a vertical stem rectangle (2 parts), though the
    // exact count depends on the algorithm's split order (Bayazit's
    // quickDecomp tends to produce 2; Hertel-Mehlhorn can collapse to 2).
    const parts = SHIP_KIND_COLLISION_PARTS.crossguard!;
    expect(parts.length, 'Crossguard must NOT collapse to a single convex hull').toBeGreaterThanOrEqual(2);
  });

  it('Heavy (convex pentagon) is a no-op decomposition: 1 part identical to input (up to winding)', () => {
    // Heavy is the only kind in the catalogue with a CONVEX polygon. A correct
    // decomposer should emit it as a single part. If it splits, that's a sign
    // the algorithm is over-eager or the input has collinear vertices.
    const parts = SHIP_KIND_COLLISION_PARTS.heavy!;
    expect(parts.length, 'heavy convex pentagon should not be split').toBe(1);
    const heavy = shipShapeToPolygon(SHIP_KINDS.heavy);
    expect(parts[0]!.length, 'heavy part vertex count matches input').toBe(heavy.length);
  });
});

describe('determinism + lookup behaviour', () => {
  it('re-reading shipCollisionParts returns the same frozen reference', () => {
    for (const kind of SHIP_KINDS_LIST) {
      expect(shipCollisionParts(kind.id)).toBe(SHIP_KIND_COLLISION_PARTS[kind.id]);
      // Same module load ⇒ same identity. Two consecutive calls return the
      // identical frozen array (no re-decomp per call).
      expect(shipCollisionParts(kind.id)).toBe(shipCollisionParts(kind.id));
    }
  });

  it('falls back to the default kind on unknown / null / undefined id', () => {
    expect(shipCollisionParts('garbage')).toBe(SHIP_KIND_COLLISION_PARTS[DEFAULT_SHIP_KIND]);
    expect(shipCollisionParts(null)).toBe(SHIP_KIND_COLLISION_PARTS[DEFAULT_SHIP_KIND]);
    expect(shipCollisionParts(undefined)).toBe(SHIP_KIND_COLLISION_PARTS[DEFAULT_SHIP_KIND]);
    expect(shipCollisionParts('scout')).toBe(SHIP_KIND_COLLISION_PARTS.scout);
  });

  it('every kind\'s parts (and outer array) are frozen', () => {
    for (const kind of SHIP_KINDS_LIST) {
      const parts = SHIP_KIND_COLLISION_PARTS[kind.id]!;
      expect(Object.isFrozen(parts), `${kind.id} outer array frozen`).toBe(true);
      for (const part of parts) {
        expect(Object.isFrozen(part), `${kind.id} part frozen`).toBe(true);
      }
    }
  });
});
