/**
 * Phase V gates — a gate structure's body is its POSTS (several convex parts),
 * so a ship flies through the gap while the posts still block (the solid
 * doors are rig bodies, docs/plans/door-power.md).
 * The same `spawnObstacle(..., parts)` runs in the server worker and the
 * client prediction world (#15).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { gateColliderPolygons } from '../structures/gateGeometry.js';
import { GATE_POSTS } from '../../shared-types/structureKinds/gatePosts.js';
import { STRUCTURE_KINDS } from '../../shared-types/structureKinds.js';

async function flyUpInto(gateX: number, shipX: number): Promise<number> {
  const w = await PhysicsWorld.create();
  w.spawnObstacle('gate', gateX, 0, STRUCTURE_KINDS.shield_gate.radius, 3, undefined, 0, undefined, gateColliderPolygons('shield_gate')!);
  w.lockBody('gate');
  w.spawnShip('ship', shipX, -150);
  for (let i = 0; i < 240; i++) {
    w.applyInput('ship', { thrust: true, turnLeft: false, turnRight: false });
    w.tick(1 / 60);
  }
  return w.getAllShipStates().get('ship')!.y;
}

describe('PhysicsWorld — gate posts as separate collider parts', () => {
  it('a ship flies straight through the open gap', async () => {
    expect(await flyUpInto(0, 0)).toBeGreaterThan(100);
  });

  it('a ship flying at a post is stopped by it', async () => {
    expect(await flyUpInto(0, GATE_POSTS[1]![0])).toBeLessThan(0);
  });
});
