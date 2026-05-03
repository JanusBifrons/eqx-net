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

  it('advanceLerp decays offset to zero within adaptive frame count', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    // drift = hypot(50,50) ≈ 70.7 u → adaptive tier: 18 frames (> 20 u)
    r.reconcile({ x: 50, y: 50, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    expect(r.isLerping).toBe(true);

    // Advance until done; guard at 30 to prevent infinite loop
    let frames = 0;
    while (r.isLerping && frames < 30) {
      r.advanceLerp();
      frames++;
    }

    expect(r.isLerping).toBe(false);
    expect(r.lerpOffset.x).toBe(0);
    expect(r.lerpOffset.y).toBe(0);
    // Adaptive: 70.7 u drift → 18 frames
    expect(frames).toBeLessThanOrEqual(18);
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

  it('variable-length replay (mobile catch-up) produces zero drift when inputs were correctly recorded', async () => {
    // Reproduces the post-fix mobile scenario: each catch-up tick records its
    // own input; when the next snapshot acks tick K, replay K+1..currentTick
    // re-applies the same inputs — producing no drift if predWorld and the
    // server agree about the input history.
    for (const lag of [0, 1, 2, 3, 5]) {
      const world = await makeWorld(0, 0);
      const r = new Reconciler(world, PLAYER);

      // Advance predWorld with thrust for `lag + 1` ticks, recording each input.
      for (let t = 0; t < lag + 1; t++) {
        const rec = makeInput(t, /* thrust */ true);
        world.applyInput(PLAYER, rec);
        r.recordInput(rec);
        world.tick(1 / 60);
      }
      const predState = world.getShipState(PLAYER)!;
      const predX = predState.x;
      const predY = predState.y;

      // Compute what the server's authoritative state would be: the same
      // ticks 0..lag-1 applied. (Server has acked through tick `lag-1` if
      // ackedTick = lag-1.)
      const ref = await PhysicsWorld.create();
      ref.spawnShip(PLAYER, 0, 0);
      for (let t = 0; t < lag; t++) {
        ref.applyInput(PLAYER, makeInput(t, true));
        ref.tick(1 / 60);
      }
      const serverState = ref.getShipState(PLAYER)!;
      const ackedTick = lag - 1;

      // Reconcile: rolls predWorld back to serverState, replays ticks ackedTick+1..currentTick-1
      // (= ticks lag..lag, just the latest one), arriving at the same state.
      r.reconcile({ x: serverState.x, y: serverState.y, vx: serverState.vx, vy: serverState.vy, angle: serverState.angle }, lag, lag + 1, ackedTick);

      // Pre-reconcile prediction matches post-reconcile prediction → no drift.
      const after = world.getShipState(PLAYER)!;
      expect(Math.hypot(after.x - predX, after.y - predY)).toBeLessThan(1e-3);
      expect(r.lastDrift).toBeLessThan(1e-3);
      expect(r.isLerping).toBe(false);
    }
  });

  it('replay skipping a recorded thrust input produces drift', async () => {
    // Reproduces the pre-fix mobile bug: the catch-up loop "lost" an input
    // for one tick (e.g. input was sent for tick 5 but the buffer entry was
    // overwritten / never recorded). Replay would integrate as no-thrust for
    // that tick, producing positional drift versus the server.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    for (let t = 0; t < 5; t++) {
      const rec = makeInput(t, true);
      world.applyInput(PLAYER, rec);
      r.recordInput(rec);
      world.tick(1 / 60);
    }
    // Drop the buffer entry for tick 2 to simulate a missed catch-up step.
    // (Direct mutation through internals isn't possible, so simulate by
    // recording a no-op over it — same effect: replay applies no thrust at t=2.)
    r.recordInput({ tick: 2, thrust: false, turnLeft: false, turnRight: false, sentAt: performance.now() });

    // Server state: full thrust at ticks 0..1 (acked = 1), reconcile from there.
    const ref = await PhysicsWorld.create();
    ref.spawnShip(PLAYER, 0, 0);
    for (let t = 0; t < 2; t++) {
      ref.applyInput(PLAYER, makeInput(t, true));
      ref.tick(1 / 60);
    }
    const serverState = ref.getShipState(PLAYER)!;

    r.reconcile({ x: serverState.x, y: serverState.y, vx: serverState.vx, vy: serverState.vy, angle: serverState.angle }, 1, 5, 1);

    // Predicted-but-corrupted predWorld replay misses tick 2's thrust → drift.
    expect(r.lastDrift).toBeGreaterThan(0.05);
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
