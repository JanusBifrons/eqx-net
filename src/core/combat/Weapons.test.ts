import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import {
  hitscanRaycast,
  spawnProjectile,
  rayHitsSphere,
  HITSCAN_RANGE,
  PROJECTILE_RADIUS,
  SHIP_COLLISION_RADIUS,
} from './Weapons.js';

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
