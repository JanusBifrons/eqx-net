import { describe, it, expect } from 'vitest';
import { rayHitsSphere, rayHitsShipPolygon, sweptSegmentHitsShipPolygon, SHIP_COLLISION_RADIUS } from './Weapons.js';
import { shipCollisionTriangles } from '../geometry/triangulate.js';

// Fighter is the canonical concave hull: points (scale 1) =
// [[0,-16],[-10,10],[0,5],[10,10]] — a notched arrowhead. Max |x| of the
// silhouette is 10 (wing tips), but the bounding collision circle is
// SHIP_COLLISION_RADIUS = 12. The band 10 < |x| < 12 is the whole point of
// "shield down ⇒ shoot the bare hull, not the circle".
const TRIS = shipCollisionTriangles('fighter');

describe('rayHitsShipPolygon — exact hull vs bounding circle', () => {
  it('a shot inside the bounding circle but OUTSIDE the hull HITS the circle but MISSES the polygon', () => {
    // Vertical ray at x = 11 (|11| < 12 circle radius, but > 10 max hull x).
    const circle = rayHitsSphere(11, -100, 0, 1, 200, 0, 0, SHIP_COLLISION_RADIUS);
    expect(circle).not.toBeNull(); // the cheap broadphase WOULD hit
    const poly = rayHitsShipPolygon(11, -100, 0, 1, 200, 0, 0, 0, TRIS);
    expect(poly).toBeNull(); // ...but the bare hull is missed (feature!)
  });

  it('a shot through the body hits the hull at the nearest triangle entry', () => {
    // Straight up the centreline (x = 0): enters at the nose (local y = -16).
    const d = rayHitsShipPolygon(0, -100, 0, 1, 200, 0, 0, 0, TRIS);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(84, 0); // -16 - (-100)
  });

  it('honours the entity angle (transform into hull-local space)', () => {
    // Rotate the ship 180°: the nose now points +y. The centreline shot
    // from +y downward must now connect; the same shot at angle 0 would
    // enter from the tail side.
    const d = rayHitsShipPolygon(0, 100, 0, -1, 200, 0, 0, Math.PI, TRIS);
    expect(d).not.toBeNull();
  });

  it('null when the ray clears the whole silhouette', () => {
    expect(rayHitsShipPolygon(500, 500, 1, 0, 50, 0, 0, 0, TRIS)).toBeNull();
  });
});

describe('sweptSegmentHitsShipPolygon — projectile step vs hull', () => {
  it('a step grazing the circle rim but outside the hull is a clean miss', () => {
    expect(sweptSegmentHitsShipPolygon(11, -50, 0, 100, 0, 0, 0, TRIS)).toBeNull();
  });

  it('a step through the body returns entry + hit point (projectileSweepCircle shape)', () => {
    const s = sweptSegmentHitsShipPolygon(0, -50, 0, 100, 0, 0, 0, TRIS);
    expect(s).not.toBeNull();
    expect(s!.entry).toBeCloseTo(34, 0); // -16 - (-50)
    expect(s!.hitX).toBeCloseTo(0, 5);
    expect(s!.hitY).toBeCloseTo(-16, 0);
  });

  it('zero-length step ⇒ null', () => {
    expect(sweptSegmentHitsShipPolygon(0, 0, 0, 0, 0, 0, 0, TRIS)).toBeNull();
  });
});
