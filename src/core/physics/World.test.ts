import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { generateAsteroidVertices } from '../swarm/asteroidShape.js';

let world: PhysicsWorld;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

describe('PhysicsWorld', () => {
  it('spawns and tracks a ship', () => {
    world.spawnShip('test-ship', 100, 200);
    const state = world.getShipState('test-ship');
    expect(state).not.toBeNull();
    expect(state!.x).toBeCloseTo(100, 1);
    expect(state!.y).toBeCloseTo(200, 1);
  });

  it('thrusts forward (along visual nose direction) at angle=0', () => {
    // At angle=0 the ship polygon nose points Pixi-up. In Rapier (Y-up) that is +Y.
    // Thrust formula: (-sin θ, cos θ). At θ=0 → (0, +1), so vy should be positive.
    world.spawnShip('drift-ship', 0, 0);
    world.applyInput('drift-ship', { thrust: true, turnLeft: false, turnRight: false });
    world.tick(1 / 60);
    const state = world.getShipState('drift-ship');
    expect(state).not.toBeNull();
    expect(state!.vy).toBeGreaterThan(0);
    expect(Math.abs(state!.vx)).toBeLessThan(0.001); // no lateral component at angle=0
  });

  it('turnLeft produces positive (CCW) angular velocity → sprite rotates CCW on screen', () => {
    // sprite.rotation = -angle, so positive ω in Rapier → angle increases →
    // sprite.rotation decreases → CCW on screen → visual left turn.
    world.spawnShip('turn-ship', 0, 0);
    world.applyInput('turn-ship', { thrust: false, turnLeft: true, turnRight: false });
    world.tick(1 / 60);
    const state = world.getShipState('turn-ship');
    expect(state!.angle).toBeGreaterThan(0); // angle should have increased (CCW)
  });

  it('despawns a ship', () => {
    world.spawnShip('temp-ship', 0, 0);
    world.despawnShip('temp-ship');
    expect(world.getShipState('temp-ship')).toBeNull();
  });

  it('returns all ship states', () => {
    world.spawnShip('multi-a', 10, 0);
    world.spawnShip('multi-b', -10, 0);
    const all = world.getAllShipStates();
    expect(all.has('multi-a')).toBe(true);
    expect(all.has('multi-b')).toBe(true);
  });

  it('applyImpulse imparts linear velocity in the requested direction', () => {
    world.spawnShip('imp-linear', 500, 500);
    world.applyImpulse('imp-linear', 5, 0, 0);
    world.tick(1 / 60);
    const state = world.getShipState('imp-linear');
    expect(state!.vx).toBeGreaterThan(0);
    expect(Math.abs(state!.vy)).toBeLessThan(0.01);
  });

  it('applyImpulse adds torque that produces angular velocity', () => {
    world.spawnShip('imp-torque', 600, 600);
    world.applyImpulse('imp-torque', 0, 0, 0.5);
    world.tick(1 / 60);
    const state = world.getShipState('imp-torque');
    // The damped ship has high angular damping (8.0) so we just check the sign survives.
    expect(state!.angvel ?? 0).toBeGreaterThan(0);
  });

  it('applyImpulse silently no-ops on unknown ids', () => {
    expect(() => world.applyImpulse('does-not-exist', 1, 1, 1)).not.toThrow();
  });

  it('isSleeping reports false on a freshly impulsed body', () => {
    world.spawnShip('sleep-check', 700, 700);
    world.applyImpulse('sleep-check', 5, 5, 0);
    world.tick(1 / 60);
    expect(world.isSleeping('sleep-check')).toBe(false);
  });

  it('isSleeping returns false for unknown ids', () => {
    expect(world.isSleeping('ghost')).toBe(false);
  });
});

describe('PhysicsWorld.spawnObstacle (polygon path)', () => {
  it('builds a convex-hull collider when vertices are provided and steps without NaN', () => {
    const verts = generateAsteroidVertices(7, 24);
    world.spawnObstacle('poly-asteroid', 1000, 1000, 24, 500, verts);
    world.tick(1 / 60);
    const state = world.getShipState('poly-asteroid');
    expect(state).not.toBeNull();
    expect(Number.isFinite(state!.x)).toBe(true);
    expect(Number.isFinite(state!.y)).toBe(true);
    expect(Number.isFinite(state!.angle)).toBe(true);
  });

  it('falls back to ball collider on degenerate vertex input', () => {
    expect(() => world.spawnObstacle('degenerate-poly', 2000, 2000, 24, 500, [])).not.toThrow();
    world.tick(1 / 60);
    expect(world.getShipState('degenerate-poly')).not.toBeNull();
  });

  it('preserves backward-compatible ball-collider path when vertices are omitted', () => {
    expect(() => world.spawnObstacle('legacy-asteroid', 3000, 3000, 32, 500)).not.toThrow();
    world.tick(1 / 60);
    expect(world.getShipState('legacy-asteroid')).not.toBeNull();
  });
});
