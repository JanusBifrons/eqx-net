import { describe, it, expect } from 'vitest';
import { rayHitsSphere, rayHitsShipPolygon, sweptSegmentHitsShipPolygon, SHIP_COLLISION_RADIUS } from './Weapons.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';

// Fighter polygon (Pixi-up authored at scale 1):
//   [[0,-16], [-10,10], [0,5], [10,10]]
// Post the 2026-05-28 Y-flip in `shipShapeToPolygon` (Pixi-up → math-up for
// Rapier/hitscan consumers), the fighter's collider sees:
//   nose      (0, +16)    math forward (math +Y)
//   left rear (-10, -10)  math backward + left
//   tail/reflex (0, -5)   concave notch facing math -Y
//   right rear (10, -10)  math backward + right
// Max |x| = 10 (wing tips); bounding circle SHIP_COLLISION_RADIUS = 12.
// The band 10 < |x| < 12 is "shield down ⇒ shoot the bare hull, not the
// circle". The lowest math Y at x=0 is the reflex vertex (0, -5); the
// highest is the nose (0, +16). A centreline ray from below (math -Y)
// going up enters at the REFLEX, not the nose.
const PARTS = shipCollisionParts('fighter');

describe('rayHitsShipPolygon — exact hull vs bounding circle', () => {
  it('a shot inside the bounding circle but OUTSIDE the hull HITS the circle but MISSES the polygon', () => {
    // Vertical ray at x = 11 (|11| < 12 circle radius, but > 10 max hull x).
    const circle = rayHitsSphere(11, -100, 0, 1, 200, 0, 0, SHIP_COLLISION_RADIUS);
    expect(circle).not.toBeNull(); // the cheap broadphase WOULD hit
    const poly = rayHitsShipPolygon(11, -100, 0, 1, 200, 0, 0, 0, PARTS);
    expect(poly).toBeNull(); // ...but the bare hull is missed (feature!)
  });

  it('a centreline shot from below the body enters at the reflex (rearmost point at x=0)', () => {
    // Ray from (0, -100) going (0, +1). Polygon's lowest math Y at x=0 is
    // the reflex vertex (0, -5) (post-Y-flip). Entry distance = -5 - (-100) = 95.
    const d = rayHitsShipPolygon(0, -100, 0, 1, 200, 0, 0, 0, PARTS);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(95, 0);
  });

  it('a centreline shot from above hits the nose first', () => {
    // Ray from (0, +100) going (0, -1). Hits the nose (0, +16) first.
    // Entry distance = 100 - 16 = 84.
    const d = rayHitsShipPolygon(0, 100, 0, -1, 200, 0, 0, 0, PARTS);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(84, 0);
  });

  it('honours the entity angle (transform into hull-local space)', () => {
    // Rotate the ship 180°: the nose now points -y in world. The centreline
    // shot from -y upward must connect; equivalent to the angle-0 "shot
    // from above" case rotated through body-local.
    const d = rayHitsShipPolygon(0, -100, 0, 1, 200, 0, 0, Math.PI, PARTS);
    expect(d).not.toBeNull();
  });

  it('null when the ray clears the whole silhouette', () => {
    expect(rayHitsShipPolygon(500, 500, 1, 0, 50, 0, 0, 0, PARTS)).toBeNull();
  });
});

describe('sweptSegmentHitsShipPolygon — projectile step vs hull', () => {
  it('a step grazing the circle rim but outside the hull is a clean miss', () => {
    expect(sweptSegmentHitsShipPolygon(11, -50, 0, 100, 0, 0, 0, PARTS)).toBeNull();
  });

  it('a step through the body returns entry + hit point at the reflex (concavity preserved)', () => {
    // Segment from (0, -50) going (0, +100). Hits polygon's reflex vertex
    // at (0, -5). Entry distance = -5 - (-50) = 45.
    const s = sweptSegmentHitsShipPolygon(0, -50, 0, 100, 0, 0, 0, PARTS);
    expect(s).not.toBeNull();
    expect(s!.entry).toBeCloseTo(45, 0);
    expect(s!.hitX).toBeCloseTo(0, 5);
    expect(s!.hitY).toBeCloseTo(-5, 0);
  });

  it('zero-length step ⇒ null', () => {
    expect(sweptSegmentHitsShipPolygon(0, 0, 0, 0, 0, 0, 0, PARTS)).toBeNull();
  });
});
