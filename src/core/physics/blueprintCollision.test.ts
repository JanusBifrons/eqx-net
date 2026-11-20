/**
 * Hologram pass-through (base loop 3F): a structure body in
 * `BLUEPRINT_COLLISION_GROUPS` collides with nothing, so a ship flies through
 * an unbuilt blueprint; `setCollisionGroups(DEFAULT)` (completion) makes the
 * same body solid again.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { BLUEPRINT_COLLISION_GROUPS, DEFAULT_COLLISION_GROUPS } from './collisionGroups.js';

let world: PhysicsWorld;
beforeAll(async () => { world = await PhysicsWorld.create(); });

const square = [{ x: -60, y: -60 }, { x: 60, y: -60 }, { x: 60, y: 60 }, { x: -60, y: 60 }];

/** Fire ship `id` at the structure at (cx, 0) from the left; return its x after 1.5 s. */
function flyAt(id: string, cx: number): number {
  world.spawnShip(id, cx - 300, 0, 'crossguard');
  world.setShipState(id, { x: cx - 300, y: 0, angle: 0, vx: 600, vy: 0 });
  for (let t = 0; t < 90; t++) world.tick(1 / 60);
  return world.getShipState(id)!.x;
}

describe('blueprint collision groups', () => {
  it('an unbuilt blueprint does not block a ship', () => {
    world.spawnObstacle('bp:1', 0, 0, 85, 1_000, square, 0, BLUEPRINT_COLLISION_GROUPS);
    world.lockBody('bp:1');
    expect(flyAt('ship:1', 0)).toBeGreaterThan(200); // straight through
    expect(world.getShipState('bp:1')!.x).toBe(0);
  });

  it('a blueprint set back to the default groups is solid', () => {
    world.spawnObstacle('bp:2', 5_000, 0, 85, 1_000, square, 0, BLUEPRINT_COLLISION_GROUPS);
    world.lockBody('bp:2');
    world.setCollisionGroups('bp:2', DEFAULT_COLLISION_GROUPS);
    expect(flyAt('ship:2', 5_000)).toBeLessThan(5_000 - 60); // stopped at its face
  });

  it('setCollisionGroups is a no-op on an unknown body', () => {
    expect(() => world.setCollisionGroups('nope', DEFAULT_COLLISION_GROUPS)).not.toThrow();
  });
});
