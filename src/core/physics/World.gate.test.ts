/**
 * Phase V gates — a gate structure's body is its POSTS (several convex parts),
 * so a ship flies through the gap while the posts still block. The gate's
 * shield span is a separate wall (`spawnWall`) toggled by the open state.
 * The same `spawnObstacle(..., parts)` runs in the server worker and the
 * client prediction world (#15).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { gateColliderPolygons, gateSpanWorld, GATE_SPAN_THICKNESS } from '../structures/gateGeometry.js';

async function flyUpInto(gateX: number, shipX: number, withSpan: boolean): Promise<number> {
  const w = await PhysicsWorld.create();
  w.spawnObstacle('gate', gateX, 0, 164, 3, undefined, 0, undefined, gateColliderPolygons('shield_gate')!);
  w.lockBody('gate');
  if (withSpan) {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    gateSpanWorld('shield_gate', gateX, 0, 0, 0, a, b);
    w.spawnWall('span', a.x, a.y, b.x, b.y, GATE_SPAN_THICKNESS);
  }
  w.spawnShip('ship', shipX, -150);
  for (let i = 0; i < 240; i++) {
    w.applyInput('ship', { thrust: true, turnLeft: false, turnRight: false });
    w.tick(1 / 60);
  }
  return w.getAllShipStates().get('ship')!.y;
}

describe('PhysicsWorld — gate posts as separate collider parts', () => {
  it('a ship flies straight through the open gap', async () => {
    expect(await flyUpInto(0, 0, false)).toBeGreaterThan(100);
  });

  it('a ship flying at a post is stopped by it', async () => {
    expect(await flyUpInto(0, 124, false)).toBeLessThan(0);
  });

  it('a closed span (the wall) blocks the gap', async () => {
    expect(await flyUpInto(0, 0, true)).toBeLessThan(0);
  });
});
