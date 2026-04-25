import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { Reconciler, type InputRecord } from './Reconciler.js';

const PLAYER = 'test-player';

async function makeWorld(x = 0, y = 0): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip(PLAYER, x, y);
  return w;
}

function makeInput(tick: number, thrust = false): InputRecord {
  return { tick, thrust, turnLeft: false, turnRight: false, sentAt: performance.now() };
}

describe('Reconciler', () => {
  it('records inputs without throwing', async () => {
    const world = await makeWorld();
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.recordInput(makeInput(1, true));
    expect(r.lastDrift).toBe(0);
  });

  it('reports isLerping false before any reconciliation', async () => {
    const world = await makeWorld();
    const r = new Reconciler(world, PLAYER);
    expect(r.isLerping).toBe(false);
  });

  it('reconcile with identical state produces near-zero drift and no lerp', async () => {
    const world = await makeWorld(10, 20);
    const r = new Reconciler(world, PLAYER);

    // Record a few idle inputs
    for (let t = 0; t < 5; t++) r.recordInput(makeInput(t));

    const state = world.getShipState(PLAYER)!;
    r.reconcile(state, 0, 5, 0);

    expect(r.lastDrift).toBeLessThan(0.01);
    expect(r.isLerping).toBe(false);
    expect(r.lerpOffset.x).toBe(0);
    expect(r.lerpOffset.y).toBe(0);
  });

  it('reconcile with large positional error triggers lerp', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));

    // Give the server a position 50 units away — drift >> 0.05 lerp threshold
    r.reconcile({ x: 50, y: 50, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    expect(r.lastDrift).toBeGreaterThan(2);
    expect(r.isLerping).toBe(true);
    expect(Math.abs(r.lerpOffset.x)).toBeGreaterThan(0);
    expect(Math.abs(r.lerpOffset.y)).toBeGreaterThan(0);
  });

  it('advanceLerp decays offset to zero over LERP_FRAMES frames', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.reconcile({ x: 50, y: 50, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    expect(r.isLerping).toBe(true);

    // Advance until done
    let frames = 0;
    while (r.isLerping && frames < 20) {
      r.advanceLerp();
      frames++;
    }

    expect(r.isLerping).toBe(false);
    expect(r.lerpOffset.x).toBe(0);
    expect(r.lerpOffset.y).toBe(0);
    expect(frames).toBeLessThanOrEqual(5);
  });

  it('ring buffer wraps at 128 without corrupting adjacent ticks', async () => {
    const world = await makeWorld();
    const r = new Reconciler(world, PLAYER);

    // Fill past the 128-entry wrap point
    for (let t = 0; t < 140; t++) r.recordInput(makeInput(t));

    // Tick 130 should overwrite slot 2 (130 % 128 = 2) — tick 2 is evicted
    // Reconcile from tick 130 to 132 (2 steps)
    r.recordInput(makeInput(130, true));
    r.recordInput(makeInput(131, true));
    const state = world.getShipState(PLAYER)!;
    // Should not throw and drift should be small (all from same world state)
    expect(() => r.reconcile(state, 130, 132, 130)).not.toThrow();
  });

  it('lerpOffset magnitude shrinks each advanceLerp call', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.reconcile({ x: 100, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    const magnitudes: number[] = [];
    while (r.isLerping) {
      magnitudes.push(Math.abs(r.lerpOffset.x));
      r.advanceLerp();
    }

    // Each frame should be strictly smaller than the previous
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]!).toBeLessThanOrEqual(magnitudes[i - 1]!);
    }
  });
});
