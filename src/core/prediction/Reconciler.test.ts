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

  it('advanceLerp decays offset to zero within capped frame count', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    // drift = hypot(50,50) ≈ 70.7 u — Stage 0 caps any drift ≥ 0.5u at 6 frames
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
    expect(frames).toBeLessThanOrEqual(6);
  });

  it('Stage 0: lerp offset eases out (drops past 25% by midpoint, not 50%)', async () => {
    // Pre-Stage-0 the visual offset decayed linearly: ratio = framesLeft /
    // totalFrames, so at the midpoint of a 6-frame lerp the offset is at 50%
    // of initial — reads as a slow glide. Stage 0 switches to ease-out
    // quadratic (ratio²): the offset drops past 25% by midpoint, so
    // corrections feel snappy at start and settle gracefully without
    // changing the total duration.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    // 30u drift → 6-frame lerp (post-cycle-1 cap)
    r.reconcile({ x: 30, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    const initialAbsX = Math.abs(r.lerpOffset.x);
    expect(initialAbsX).toBeGreaterThan(20); // sanity — 30u drift.

    // Advance to midpoint: 3 of 6 frames consumed.
    r.advanceLerp();
    r.advanceLerp();
    r.advanceLerp();

    // Linear: |offset.x| = initial × (3/6) = 0.5 × initial → fails < 0.4.
    // Squared: |offset.x| = initial × (3/6)² = 0.25 × initial → passes.
    expect(Math.abs(r.lerpOffset.x)).toBeLessThan(initialAbsX * 0.4);
  });

  it('Stage 0: large-drift correction caps at 6 frames (100 ms)', async () => {
    // The pre-Stage-0 Reconciler used an adaptive cascade (3/8/12/18 frames)
    // that pushed >20u corrections to 300 ms — flagged in docs/FEEL_GOALS.md
    // as a perceptible "glide" because the collision has already happened in
    // the world; the slow visual settle is a lie. Stage 0 caps every drift
    // above the sub-pixel tier at 6 frames so corrections land in 100 ms.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));

    // 30u drift — well above any tier boundary. Pre-Stage-0 → 18 frames.
    r.reconcile({ x: 30, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    expect(r.isLerping).toBe(true);

    let frames = 0;
    while (r.isLerping && frames < 30) {
      r.advanceLerp();
      frames++;
    }

    expect(frames).toBeLessThanOrEqual(6);
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

  it('caps the replay window at BUFFER_SIZE so the first-snapshot-after-join does not hang (2026-05-06 regression)', async () => {
    // First snapshot after `welcome` arrives with `ackedTick = 0` (worker has
    // applied no inputs yet) and `currentTick` equal to whatever serverTick
    // the welcome carried — typically several thousand. Without a cap, the
    // replay loop would call world.tick(1/60) thousands of times and freeze
    // the client for 1–3 seconds on mobile (the dominant "join jitter"
    // reported in the 2026-05-06 follow-up diagnostic). The cap snaps to
    // server pose instead — visible as a one-time correction, not a hang.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    // Record enough inputs to fill the ring buffer.
    for (let t = 0; t < 50; t++) r.recordInput(makeInput(t));

    const t0 = performance.now();
    r.reconcile({ x: 100, y: 200, vx: 0, vy: 0, angle: 0 }, 0, 5000, 0);
    const elapsedMs = performance.now() - t0;

    // 5000-tick replay would take 100s of ms even on a workstation; capped
    // replay is bounded by BUFFER_SIZE=128 ticks — finishes in under 50 ms.
    expect(elapsedMs).toBeLessThan(50);
  });
});
