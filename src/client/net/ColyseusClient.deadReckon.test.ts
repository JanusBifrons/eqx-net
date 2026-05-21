/**
 * Render-jitter-fix Phase 1 — dead-reckon-between-physics-ticks lock.
 *
 * The bug class this catches:
 *
 *   On a 90 Hz mobile display with 60 Hz physics, some RAFs fire
 *   without advancing a physics tick (the wall-clock-anchored loop
 *   computes a target tick that hasn't advanced enough since the
 *   last tick). Pre-fix, those 0-step RAFs called `updateMirror` and
 *   composed `predWorld pose + lerp` — identical to the prior frame
 *   because `predWorld` didn't tick. Clusters of 0-step RAFs ≥ 4
 *   frames produce the user-reported "stop-start" visual jitter.
 *
 *   The fix dead-reckons the rendered pose forward by `(clock.now() -
 *   _lastLocalTickAtMs) × velocity` so every RAF shows velocity-based
 *   motion. When the next physics tick fires, predWorld advances to
 *   the post-tick pose (which equals the previous-tick pose + dt ×
 *   velocity, modulo a sub-pixel acceleration term), so the
 *   dead-reckon ↔ authoritative-tick transition is visually continuous.
 *
 * Why this test layer (Invariant #13 — "test where the bug LIVES"):
 *   - The bug surfaces in the RENDERER's per-frame pose, but its cause
 *     is the dead-reckon arithmetic in ColyseusClient.updateMirror.
 *   - End-to-end validation (replay harness against on-device capture)
 *     is unreliable: the harness drifts ~232 u from on-device over
 *     60 s, especially in velocity (no drone/projectile state to drive
 *     collisions), so harness-rendered streams are not a faithful
 *     surrogate for the fix's behaviour.
 *   - The integration seam between predWorld + clock + reconciler +
 *     mirror is the right level — testable with mocked clock + real
 *     predWorld, mirroring `ColyseusClient.mountAnglesPreservation.test.ts`'s
 *     internals-access pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { MockClock } from '../../core/clock/Clock.js';

interface Internals {
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  reconciler:
    | {
        lerpOffset: { x: number; y: number };
        lerpAngleOffset: number;
        advanceLerp(ms: number): void;
        isLerping: boolean;
      }
    | null;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>;
    localPlayerId: string | null;
  };
  lastFrameMs: number;
  _lastLocalTickAtMs: number;
  clock: MockClock;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function mockReconciler(): {
  lerpOffset: { x: number; y: number };
  lerpAngleOffset: number;
  advanceLerp(ms: number): void;
  isLerping: boolean;
} {
  return {
    lerpOffset: { x: 0, y: 0 },
    lerpAngleOffset: 0,
    isLerping: false,
    advanceLerp(_ms: number) { /* no-op */ },
  };
}

describe('render-jitter-fix Phase 1 — dead-reckon between physics ticks', () => {
  let client: ColyseusGameClient;
  let internals: Internals;
  let clock: MockClock;
  const LOCAL_ID = 'player-1';

  beforeEach(async () => {
    clock = new MockClock(0);
    client = new ColyseusGameClient(clock);
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    internals.predWorld.spawnShip(LOCAL_ID, 100, 200, 'interceptor');
    // Stamp predWorld with a non-zero velocity (the typical mid-thrust state).
    internals.predWorld.setShipState(LOCAL_ID, {
      x: 100, y: 200, vx: 60, vy: -30, angle: 0, angvel: 0,
    });
    internals.reconciler = mockReconciler();
    internals.mirror.localPlayerId = LOCAL_ID;
    internals.lastFrameMs = 1000 / 60;
  });

  it('renders identical pose on the FIRST RAF after a physics tick (dt=0)', () => {
    // Simulate: tickPhysics just fired one tick, stamping _lastLocalTickAtMs.
    // updateMirror runs in the same RAF at the same clock.now() → dt=0.
    internals._lastLocalTickAtMs = clock.now();
    internals.updateMirror();
    const rendered = internals.mirror.ships.get(LOCAL_ID);
    expect(rendered, 'mirror entry must exist').toBeDefined();
    expect(rendered!.x).toBeCloseTo(100, 6);
    expect(rendered!.y).toBeCloseTo(200, 6);
  });

  it('dead-reckons forward by velocity × dt on a subsequent 0-step RAF', () => {
    // Tick fired at t=0; subsequent RAF at t=16 with no new tick.
    internals._lastLocalTickAtMs = 0;
    clock.set(16);
    internals.lastFrameMs = 16;
    internals.updateMirror();
    const rendered = internals.mirror.ships.get(LOCAL_ID);
    expect(rendered, 'mirror entry must exist').toBeDefined();
    // x grows by vx × dt = 60 × 0.016 = 0.96
    expect(rendered!.x).toBeCloseTo(100 + 0.96, 2);
    // y shrinks by 30 × 0.016 = 0.48
    expect(rendered!.y).toBeCloseTo(200 + -0.48, 2);
  });

  it('advances rendered pose on each consecutive 0-step RAF', () => {
    // Three RAFs after a tick, no new ticks, dt growing 8/16/24 ms.
    internals._lastLocalTickAtMs = 0;
    const samples: { x: number; y: number }[] = [];
    for (const tMs of [8, 16, 24]) {
      clock.set(tMs);
      internals.lastFrameMs = 8;
      internals.updateMirror();
      const r = internals.mirror.ships.get(LOCAL_ID)!;
      samples.push({ x: r.x, y: r.y });
    }
    // Each successive sample should be advanced from the previous.
    expect(samples[1]!.x).toBeGreaterThan(samples[0]!.x);
    expect(samples[2]!.x).toBeGreaterThan(samples[1]!.x);
    // Position at t=24ms should reflect 24ms of motion from the tick.
    expect(samples[2]!.x).toBeCloseTo(100 + 60 * 0.024, 2);
  });

  it('caps dead-reckon dt at 32 ms (no wild extrapolation on multi-second stalls)', () => {
    // RAF 5 seconds after the last tick (tab background / OS reap).
    internals._lastLocalTickAtMs = 0;
    clock.set(5000);
    internals.lastFrameMs = 5000;
    internals.updateMirror();
    const rendered = internals.mirror.ships.get(LOCAL_ID)!;
    // dt clamped to 32 ms; motion = 60 × 0.032 = 1.92, NOT 60 × 5 = 300.
    const expectedClamped = 100 + 60 * 0.032;
    expect(rendered.x).toBeCloseTo(expectedClamped, 2);
    expect(rendered.x).toBeLessThan(110); // sanity: well below the 300u runaway
  });

  it('skips dead-reckon entirely during the boot window (sentinel -1, no tick yet)', () => {
    // _lastLocalTickAtMs sentinel -1 = "no tick has fired yet" — render
    // at raw predWorld pose with no dead-reckon. Production initial
    // value is -1; resetPredictionState resets to -1 on transit handoff.
    internals._lastLocalTickAtMs = -1;
    clock.set(100);
    internals.updateMirror();
    const rendered = internals.mirror.ships.get(LOCAL_ID)!;
    expect(rendered.x).toBeCloseTo(100, 2);
    expect(rendered.y).toBeCloseTo(200, 2);
  });

  it('renders stationary pose without motion when velocity is zero', () => {
    // Stationary ship — dead-reckon × 0 = 0. Frame stays identical.
    internals.predWorld!.setShipState(LOCAL_ID, {
      x: 50, y: -50, vx: 0, vy: 0, angle: 0, angvel: 0,
    });
    internals._lastLocalTickAtMs = 0;
    const positions: { x: number; y: number }[] = [];
    for (const tMs of [16, 32, 48, 64]) {
      clock.set(tMs);
      internals.updateMirror();
      const r = internals.mirror.ships.get(LOCAL_ID)!;
      positions.push({ x: r.x, y: r.y });
    }
    // All positions identical — stationary ship correctly stays still.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!.x).toBe(positions[0]!.x);
      expect(positions[i]!.y).toBe(positions[0]!.y);
    }
  });

  it('applies lerpOffset on top of the dead-reckoned pose', () => {
    internals.reconciler!.lerpOffset.x = 5;
    internals.reconciler!.lerpOffset.y = -3;
    internals.reconciler!.isLerping = true;
    internals._lastLocalTickAtMs = 0;
    clock.set(16);
    internals.updateMirror();
    const r = internals.mirror.ships.get(LOCAL_ID)!;
    // Dead-reckon: (100 + 60×0.016, 200 + -30×0.016) = (100.96, 199.52)
    // Lerp on top: (100.96 + 5, 199.52 + -3) = (105.96, 196.52)
    expect(r.x).toBeCloseTo(105.96, 2);
    expect(r.y).toBeCloseTo(196.52, 2);
  });
});
