import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import {
  hitscanRaycast,
  spawnProjectile,
  rayHitsSphere,
  rayHitsConvexPolygon,
  HITSCAN_RANGE,
  PROJECTILE_RADIUS,
  SHIP_COLLISION_RADIUS,
} from './Weapons.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

describe('rayHitsSphere (geometric, no Rapier)', () => {
  it('hits a sphere directly ahead', () => {
    const dist = rayHitsSphere(0, 0, 1, 0, 500, 100, 0, 12);
    expect(dist).not.toBeNull();
    expect(dist!).toBeCloseTo(88, 0);
  });

  it('returns null when sphere is behind the ray', () => {
    const dist = rayHitsSphere(0, 0, 1, 0, 500, -50, 0, 12);
    expect(dist).toBeNull();
  });

  it('returns null on a clear miss', () => {
    const dist = rayHitsSphere(0, 0, 1, 0, 500, 100, 50, 12);
    expect(dist).toBeNull();
  });

  it('returns null when hit is beyond maxDist', () => {
    const dist = rayHitsSphere(0, 0, 1, 0, 50, 100, 0, 12);
    expect(dist).toBeNull();
  });

  it('hits when ray origin is inside the sphere', () => {
    const dist = rayHitsSphere(0, 0, 1, 0, 500, 5, 0, 12);
    expect(dist).not.toBeNull();
  });
});

describe('rayHitsConvexPolygon (geometric, no Rapier)', () => {
  // Axis-aligned square centred at origin, side length 20.
  const square: Vec2[] = [
    { x: -10, y: -10 },
    { x:  10, y: -10 },
    { x:  10, y:  10 },
    { x: -10, y:  10 },
  ];

  it('hits a centred square head-on', () => {
    // Ray from (-100, 0) along +x at the square at origin.
    const dist = rayHitsConvexPolygon(-100, 0, 1, 0, 500, 0, 0, 0, square);
    expect(dist).not.toBeNull();
    expect(dist!).toBeCloseTo(90, 5); // hits the left edge at x=-10
  });

  it('returns null when the ray misses the polygon entirely', () => {
    const dist = rayHitsConvexPolygon(-100, 100, 1, 0, 500, 0, 0, 0, square);
    expect(dist).toBeNull();
  });

  it('respects rotation — ray that would miss the local-space silhouette misses too', () => {
    // Skinny "wall" rectangle: 40 wide × 4 tall, centred at origin.
    const wall: Vec2[] = [
      { x: -20, y: -2 },
      { x:  20, y: -2 },
      { x:  20, y:  2 },
      { x: -20, y:  2 },
    ];
    // With angle=0, a ray along +y from (0, -100) hits the wall (it's 40 wide).
    const hitFlat = rayHitsConvexPolygon(0, -100, 0, 1, 500, 0, 0, 0, wall);
    expect(hitFlat).not.toBeNull();
    // Rotate the wall 90° (so it's now 40 tall × 4 wide). Same ray now
    // hits the narrow edge near x=0, dist ≈ 100 - 2 = 98.
    const hitRotated = rayHitsConvexPolygon(0, -100, 0, 1, 500, 0, 0, Math.PI / 2, wall);
    expect(hitRotated).not.toBeNull();
    // A ray from (10, -100) along +y misses the rotated wall (now 4 wide centred at x=0).
    const miss = rayHitsConvexPolygon(10, -100, 0, 1, 500, 0, 0, Math.PI / 2, wall);
    expect(miss).toBeNull();
  });

  it('returns null when the polygon is behind the ray', () => {
    const dist = rayHitsConvexPolygon(0, 0, 1, 0, 500, -100, 0, 0, square);
    expect(dist).toBeNull();
  });

  it('returns null when hit distance exceeds maxDist', () => {
    const dist = rayHitsConvexPolygon(-1000, 0, 1, 0, 500, 0, 0, 0, square);
    expect(dist).toBeNull();
  });

  it('returns 0 when the ray origin is already inside the polygon', () => {
    const dist = rayHitsConvexPolygon(0, 0, 1, 0, 500, 0, 0, 0, square);
    expect(dist).toBe(0);
  });

  it('returns null on degenerate input (< 3 vertices)', () => {
    expect(rayHitsConvexPolygon(0, 0, 1, 0, 500, 0, 0, 0, [])).toBeNull();
    expect(rayHitsConvexPolygon(0, 0, 1, 0, 500, 0, 0, 0, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });

  it('grazing ray that hits the bounding circle but misses the polygon silhouette returns null', () => {
    // Axis-aligned 20×20 square at origin. Bounding circle radius = √200 ≈ 14.14.
    // A ray at y=13 is INSIDE the bounding circle (|y|<14.14) but ABOVE the
    // polygon (y>10). This is exactly the case the bounding-circle hit test
    // would false-positive on; the polygon test must reject it.
    const grazingMiss = rayHitsConvexPolygon(-100, 13, 1, 0, 500, 0, 0, 0, square);
    expect(grazingMiss).toBeNull();
    // Same ray geometry but well inside the polygon (y=5) → hits.
    const insideY = rayHitsConvexPolygon(-100, 5, 1, 0, 500, 0, 0, 0, square);
    expect(insideY).not.toBeNull();
    // Sanity: the bounding-circle test would have *incorrectly* hit the
    // grazing ray, so contrasting the two sharpens the regression value.
    const boundingCircleR = Math.sqrt(200);
    const sphereHit = rayHitsSphere(-100, 13, 1, 0, 500, 0, 0, boundingCircleR);
    expect(sphereHit).not.toBeNull();
  });
});

describe('hitscanRaycast (real Rapier world)', () => {
  let world: PhysicsWorld;

  beforeEach(async () => {
    world = await PhysicsWorld.create();
    world.spawnShip('shooter', 0, 0);
    world.spawnShip('target', 100, 0);
    // Step the world once so the query pipeline registers the new colliders.
    world.tick(1 / 60);
  });

  afterEach(() => {
    world.dispose();
  });

  it('returns target when ray passes through it', () => {
    const result = hitscanRaycast(world, 0, 0, 1, 0, HITSCAN_RANGE, 'shooter');
    expect(result).not.toBeNull();
    expect(result!.hitId).toBe('target');
    expect(result!.dist).toBeGreaterThan(80);
    expect(result!.dist).toBeLessThan(100);
  });

  it('returns null when ray misses all bodies', () => {
    const result = hitscanRaycast(world, 0, 0, 0, 1, HITSCAN_RANGE, 'shooter');
    expect(result).toBeNull();
  });

  it('excludes the shooter body', () => {
    // Shoot directly at 0,0 — the shooter itself is there; ray should hit target, not shooter
    const result = hitscanRaycast(world, -50, 0, 1, 0, HITSCAN_RANGE, 'shooter');
    expect(result).not.toBeNull();
    expect(result!.hitId).toBe('target');
  });

  it('returns null when target is out of range', () => {
    const result = hitscanRaycast(world, 0, 0, 1, 0, 50, 'shooter');
    expect(result).toBeNull();
  });
});

describe('spawnProjectile (real Rapier world)', () => {
  let world: PhysicsWorld;

  beforeEach(async () => {
    world = await PhysicsWorld.create();
  });

  afterEach(() => {
    world.dispose();
  });

  it('spawns a body that can be retrieved via getShipState', () => {
    spawnProjectile(world, 'proj-1', 10, 20, HITSCAN_RANGE, 0, PROJECTILE_RADIUS);
    const state = world.getShipState('proj-1');
    expect(state).not.toBeNull();
    expect(state!.x).toBeCloseTo(10, 1);
    expect(state!.y).toBeCloseTo(20, 1);
  });

  it('spawned projectile has the correct initial velocity', () => {
    spawnProjectile(world, 'proj-2', 0, 0, 200, 0, PROJECTILE_RADIUS);
    const state = world.getShipState('proj-2');
    expect(state!.vx).toBeCloseTo(200, 0);
    expect(state!.vy).toBeCloseTo(0, 0);
  });

  it('projectile does not appear in hitscan (sensor collider)', () => {
    // A sensor body does not block rays
    world.spawnShip('shooter', 0, 0);
    world.spawnShip('target', 200, 0);
    spawnProjectile(world, 'proj-3', 100, 0, 0, 0, PROJECTILE_RADIUS);
    world.tick(1 / 60);
    const result = hitscanRaycast(world, 0, 0, 1, 0, HITSCAN_RANGE, 'shooter');
    expect(result).not.toBeNull();
    expect(result!.hitId).toBe('target');
  });

  it('projectile collision radius constant is defined', () => {
    expect(SHIP_COLLISION_RADIUS).toBe(12);
  });
});
