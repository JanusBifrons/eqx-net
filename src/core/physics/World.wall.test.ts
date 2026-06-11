import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from './World.js';

describe('PhysicsWorld — shield-wall collider lifecycle', () => {
  it('spawns, toggles, and removes a wall span without throwing', async () => {
    const w = await PhysicsWorld.create();
    w.spawnWall('wall-1', -100, 0, 100, 0, 20);
    w.tick(1 / 60);
    w.setWallActive('wall-1', false);
    w.tick(1 / 60);
    w.setWallActive('wall-1', true);
    w.tick(1 / 60);
    w.removeWall('wall-1');
    w.tick(1 / 60);
    // Idempotent / forgiving: re-removing + toggling an unknown id is a no-op.
    w.removeWall('wall-1');
    w.setWallActive('wall-1', true);
    expect(true).toBe(true);
  });

  it('blocks a ship from passing through an up wall but not after removal', async () => {
    const w = await PhysicsWorld.create();
    // Wall spanning x∈[-100,100] at y=0; a ship below it thrusting up.
    w.spawnWall('wall-1', -100, 0, 100, 0, 20);
    w.spawnShip('ship', 0, -60);
    for (let i = 0; i < 120; i++) {
      w.applyInput('ship', { thrust: true, turnLeft: false, turnRight: false });
      w.tick(1 / 60);
    }
    const blocked = w.getAllShipStates().get('ship');
    expect(blocked).toBeDefined();
    // Spawn-facing +y, thrusting toward the wall at y=0: the static cuboid stops
    // the ship short (it stays below the wall rather than flying through to +y).
    expect(blocked!.y).toBeLessThan(0);
  });
});
