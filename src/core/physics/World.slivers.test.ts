/**
 * Capital destruction S2b: a wreck piece made of several convex parts can
 * include a thin sliver triangle (height < 1 u) that Rapier's convex hull
 * cannot build ("expected instance of …" thrown from createCollider). Found
 * by the S2b late-joiner test: one such piece threw inside the physics worker
 * and killed the whole worker pool. `spawnObstacle` must skip a part Rapier
 * rejects and keep the rest, on the server worker and the client predWorld
 * alike (same code, so the two twins still match).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';

let world: PhysicsWorld;
beforeAll(async () => {
  world = await PhysicsWorld.create();
});

describe('PhysicsWorld.spawnObstacle — a part Rapier cannot hull', () => {
  it('skips the sliver and keeps the solid parts', () => {
    const sliver = [
      { x: -21.81825767289041, y: 126.96960883610245 },
      { x: 166.9786173271096, y: 98.70398383610245 },
      { x: 104.22861732710959, y: 108.93835883610245 },
    ];
    const box = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }];
    expect(() => world.spawnObstacle('sliver-piece', 0, 0, 200, 100, undefined, 0.05, undefined, [sliver, box])).not.toThrow();
    expect(world.hasShip('sliver-piece')).toBe(true);
    world.tick(1 / 60);
    // The solid part still blocks a ray through the middle.
    expect(world.hitscan(-500, 0, 1, 0, 1000, '')?.hitId).toBe('sliver-piece');
  });
});
