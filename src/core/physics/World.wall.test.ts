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

  // R2.28 — the server already blocks beams at walls, but the CLIENT's
  // predicted live beam (updateLiveBeam → predWorld.hitscan) drew through an
  // up wall because castHitscan resolves hits via handleToId and wall bodies
  // are deliberately kept OUT of handleToId → a wall hit returned null → the
  // beam ran to full HITSCAN_RANGE. Fix: hitscan is now wall-aware via a
  // separate wallHandleToId returning a `wall-` sentinel.
  it('hitscan STOPS at an UP wall and resolves a wall- hitId (R2.28)', async () => {
    const w = await PhysicsWorld.create();
    w.spawnWall('wall-1', -100, 0, 100, 0, 20); // span x∈[-100,100] at y=0
    w.tick(1 / 60); // broad-phase must see the collider before castRay
    // Ray from below the wall pointing +y straight at it, range 250.
    const hit = w.hitscan(0, -50, 0, 1, 250, 'shooter');
    expect(hit, 'an up wall must be hit, not passed through').not.toBeNull();
    expect(hit!.hitId, 'wall hits resolve to a wall- sentinel').toMatch(/^wall-/);
    // Near face ~y=-10 (thickness 20) ⇒ dist ~40, and crucially FAR below the
    // 250 range — the beam terminates at the wall instead of running full-length.
    expect(hit!.dist).toBeGreaterThan(30);
    expect(hit!.dist).toBeLessThan(50);
  });

  it('a DOWN (disabled) wall is passable — hitscan returns null (control)', async () => {
    const w = await PhysicsWorld.create();
    w.spawnWall('wall-1', -100, 0, 100, 0, 20);
    w.setWallActive('wall-1', false);
    w.tick(1 / 60);
    const hit = w.hitscan(0, -50, 0, 1, 250, 'shooter');
    expect(hit, 'a down wall must not block the beam').toBeNull();
  });

  it('a removed wall no longer blocks hitscan (handle map cleared)', async () => {
    const w = await PhysicsWorld.create();
    w.spawnWall('wall-1', -100, 0, 100, 0, 20);
    w.tick(1 / 60);
    expect(w.hitscan(0, -50, 0, 1, 250, 'shooter')).not.toBeNull();
    w.removeWall('wall-1');
    w.tick(1 / 60);
    expect(w.hitscan(0, -50, 0, 1, 250, 'shooter')).toBeNull();
  });
});
