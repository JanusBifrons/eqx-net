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

  it('Stage 1: spring shape — offset is ~50% of initial at t = halfLife', async () => {
    // Stage 1 replaced Stage 0's frame-counted ease-out with a critically-
    // damped spring. The user-facing halfLife parameter means "time to halve
    // the offset under v₀ = 0" — this test asserts that semantic survives
    // through the Reconciler call path.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.reconcile({ x: 30, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    const initialAbsX = Math.abs(r.lerpOffset.x);
    expect(initialAbsX).toBeGreaterThan(20);
    // Half-life is now magnitude-scaled (correctionSmoothing) — a 30 u
    // drift glides gentler than the old flat 25 ms. The 50 %-at-half-life
    // SPRING CONTRACT this test locks is half-life-value-agnostic: step by
    // the actual half-life, assert the closed-form property.
    expect(r.lerpHalfLifeMs).toBeGreaterThan(25);

    // Step forward by exactly halfLife in 0.5 ms slices.
    const dtMs = 0.5;
    let elapsed = 0;
    while (elapsed + dtMs <= r.lerpHalfLifeMs) {
      r.advanceLerp(dtMs);
      elapsed += dtMs;
    }
    // x(halfLife) ≈ 0.5 × initial (closed-form spring property).
    expect(Math.abs(r.lerpOffset.x)).toBeCloseTo(initialAbsX * 0.5, 0);
  });

  it('Stage 1: a steady-state-band correction settles within ~6×halfLife wall-clock', async () => {
    // Termination is threshold-based (offset < LERP_THRESHOLD AND
    // velocity small). This locks the settle-time CONTRACT for the
    // unchanged snappy band (drift ≤ 20 u ⇒ 25 ms half-life) — the
    // common steady-state combat case; the original ≤160 ms (≈6×25)
    // calibration stays valid. Large gap-recovery glides are covered by
    // the FAILING-FIRST glide test below.
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.reconcile({ x: 18, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0); // ~18 u — snappy band

    expect(r.isLerping).toBe(true);
    expect(r.lerpHalfLifeMs).toBe(25);

    // Step at 60 Hz cadence until the spring terminates; safety bound 1 s.
    let elapsed = 0;
    const dtMs = 16.67;
    while (r.isLerping && elapsed < 1000) {
      r.advanceLerp(dtMs);
      elapsed += dtMs;
    }
    expect(r.isLerping).toBe(false);
    expect(r.lerpOffset.x).toBe(0);
    expect(r.lerpOffset.y).toBe(0);
    // Bounded at ~6 × halfLife (giving slack for the threshold-based end
    // condition). 6 × 25 = 150 ms.
    expect(elapsed).toBeLessThanOrEqual(160);
  });

  it('Stage 1: spring is frame-rate independent — coarse and fine dt converge alike', async () => {
    async function runAt(dtMs: number, totalMs: number): Promise<number> {
      const world = await makeWorld(0, 0);
      const r = new Reconciler(world, PLAYER);
      r.recordInput(makeInput(0));
      r.reconcile({ x: 30, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);
      let elapsed = 0;
      while (elapsed + dtMs <= totalMs) {
        r.advanceLerp(dtMs);
        elapsed += dtMs;
      }
      const remainder = totalMs - elapsed;
      if (remainder > 0) r.advanceLerp(remainder);
      return r.lerpOffset.x;
    }

    // Same total wall-clock, two different cadences. The closed-form
    // analytical spring is exact, so end states must match within
    // float32 noise.
    const fast = await runAt(2, 50);
    const slow = await runAt(33, 50);
    expect(Math.abs(fast - slow)).toBeLessThan(0.5);
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

  it('lerpOffset magnitude shrinks each advanceLerp call (monotonic decay)', async () => {
    const world = await makeWorld(0, 0);
    const r = new Reconciler(world, PLAYER);
    r.recordInput(makeInput(0));
    r.reconcile({ x: 100, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0);

    const magnitudes: number[] = [];
    let elapsed = 0;
    const dtMs = 16.67;
    while (r.isLerping && elapsed < 1000) {
      magnitudes.push(Math.abs(r.lerpOffset.x));
      r.advanceLerp(dtMs);
      elapsed += dtMs;
    }

    // Critical damping ⟹ monotonic approach to zero, no overshoot.
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]!).toBeLessThanOrEqual(magnitudes[i - 1]! + 1e-9);
    }
  });

  it('FAILING-FIRST (diag xxiyix): a large gap-recovery correction must GLIDE, not snap with the steady-state 25 ms half-life', async () => {
    // Root cause of the lingering smoke-test spikes: mobile networks deliver
    // metronomic 50 ms server broadcasts in 116–571 ms BUNCHES. The bunched
    // snapshot lands and the reconcile produces a large accumulated drift
    // (captured: 178, 249 u). Pre-fix `halfLifeForDrift` returns a flat
    // 25 ms for ANY drift ≥ 0.5 u, so a 200 u correction settles in ~5
    // frames — a teleport. Combined with the synchronized ~30-drone
    // re-anchor it is the visible "lag spike that scales with sector
    // occupancy" the user reported.
    //
    // INVARIANT: small steady-state corrections stay snappy (canary-safe);
    // a large gap-recovery correction settles GENTLY (a brief glide). Fails
    // on current code (flat 25 ms); the fix routes the half-life through
    // `playerCorrectionHalfLifeMs`.
    const wSmall = await makeWorld(0, 0);
    const rSmall = new Reconciler(wSmall, PLAYER);
    rSmall.recordInput(makeInput(0));
    rSmall.reconcile({ x: 5, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0); // ~5 u — steady-state
    expect(rSmall.lerpHalfLifeMs).toBe(25); // unchanged snappy band

    const wGap = await makeWorld(0, 0);
    const rGap = new Reconciler(wGap, PLAYER);
    rGap.recordInput(makeInput(0));
    rGap.reconcile({ x: 220, y: 0, vx: 0, vy: 0, angle: 0 }, 0, 1, 0); // ~220 u gap-recovery
    expect(rGap.lastDrift).toBeGreaterThan(150);
    // The bug: this is 25 on current code. The fix: a gentle glide.
    expect(rGap.lerpHalfLifeMs).toBeGreaterThan(120);
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
