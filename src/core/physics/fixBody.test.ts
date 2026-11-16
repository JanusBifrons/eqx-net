/**
 * Cut-field rocks (macro terrain C2): a fixed rock ignores an impulse; once
 * `unfixBody` wakes it, the same impulse moves it. `unfixBody` on a body that
 * is not fixed (or missing) is a no-op.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';

let world: PhysicsWorld;
beforeAll(async () => { world = await PhysicsWorld.create(); });

const square = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }];

describe('PhysicsWorld fixBody / unfixBody', () => {
  it('a fixed rock stays put under an impulse; woken, it moves', () => {
    world.spawnObstacle('field:1', 0, 0, 71, 1_000, square);
    world.fixBody('field:1');
    world.applyImpulse('field:1', 50_000, 0, 0);
    for (let t = 0; t < 10; t++) world.tick(1 / 60);
    expect(world.getShipState('field:1')!.x).toBe(0);

    world.unfixBody('field:1');
    world.applyImpulse('field:1', 50_000, 0, 0);
    for (let t = 0; t < 10; t++) world.tick(1 / 60);
    expect(world.getShipState('field:1')!.x).toBeGreaterThan(1);
  });

  it('is a no-op on a missing or already-dynamic body', () => {
    expect(() => world.unfixBody('nope')).not.toThrow();
    world.spawnObstacle('rock:2', 500, 0, 71, 1_000, square);
    world.unfixBody('rock:2');
    expect(world.getShipState('rock:2')!.x).toBe(500);
  });
});
