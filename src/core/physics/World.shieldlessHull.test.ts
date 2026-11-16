/**
 * A ship kind with no shield pool (`shieldMax` 0: every capital, owner
 * 2026-11-16) collides on its hull from spawn and never mounts a shield
 * collider, on the server worker and the client predWorld alike (#15).
 */
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

describe('shieldless kinds collide on their hull', () => {
  it('a destroyer drone spawns hull-exposed and stays so', async () => {
    const w = await PhysicsWorld.create();
    const k = getShipKind('destroyer');
    w.spawnObstacle('cap', 0, 0, k.radius, 100, undefined, k.linearDamping, undefined, undefined, k);
    expect(w.isHullExposed('cap')).toBe(true);
    w.setHullExposed('cap', false, k); // a stray "shield restored" never mounts a bubble
    expect(w.isHullExposed('cap')).toBe(true);
  });

  it('a fighter drone still spawns shield-up', async () => {
    const w = await PhysicsWorld.create();
    const k = getShipKind('fighter');
    w.spawnObstacle('fig', 0, 0, k.radius, 1, undefined, k.linearDamping, undefined, undefined, k);
    expect(w.isHullExposed('fig')).toBe(false);
  });

  it('a destroyer ship body spawns hull-exposed', async () => {
    const w = await PhysicsWorld.create();
    w.spawnShip('p1', 0, 0, 'destroyer');
    expect(w.isHullExposed('p1')).toBe(true);
  });
});
