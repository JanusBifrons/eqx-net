/**
 * Reconciler.reconcile signature + behaviour lock — drone-snapshot-
 * interpolation pivot, Step 6.
 *
 * The pivot retired the Phase-C drone reconcile anchor: `reconcile` no
 * longer takes a `replaySeed?: { drones?: ... }` 6th parameter, and the
 * replay loop no longer re-seeds drone bodies. This lock asserts:
 *
 *  1. SIGNATURE — the drone-seed param is gone (a compile-time
 *     `@ts-expect-error`: if anyone re-adds it the directive goes unused
 *     and typecheck fails — the param cannot silently come back).
 *  2. BEHAVIOUR — player roll-back + input replay still works, and the
 *     `perReplayTick` hook (the seam the orchestrator now uses ONLY for
 *     `applyRemoteInputs()`, i.e. remote-ship forward-prediction) is
 *     still invoked exactly once per replayed tick. Remote replay intact;
 *     no drone path involved.
 *
 * Pure: real `PhysicsWorld` (Rapier WASM in beforeAll), no network, no
 * DOM. Re-runnable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld, type ShipPhysicsState } from '../physics/World.js';
import { Reconciler } from './Reconciler.js';

let world: PhysicsWorld;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

describe('Reconciler.reconcile — drone-seed param retired (signature lock)', () => {
  it('cannot be called with a 6th drone-seed argument (compile-time)', () => {
    const r = new Reconciler(world, 'sig-probe');
    // The 5-arg form is the only form. If the retired
    // `replaySeed?: { drones?: ReadonlyMap<string, ShipPhysicsState> }`
    // parameter is ever re-introduced, the @ts-expect-error below stops
    // suppressing an error and `tsc` fails with TS2578 (unused
    // directive) — the dual-correction-path can't silently return.
    const NEVER = false as boolean;
    if (NEVER) {
      // @ts-expect-error — reconcile has no 6th (drone replaySeed) param post-pivot
      r.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 0, 0, 0, () => {}, {
        drones: new Map<string, ShipPhysicsState>(),
      });
    }
    expect(typeof r.reconcile).toBe('function');
  });
});

describe('Reconciler.reconcile — player + remote-hook replay intact', () => {
  it('rolls back to server state, replays buffered inputs, and fires perReplayTick once per replayed tick', () => {
    world.despawnShip('p');
    world.spawnShip('p', 999, 999); // pre-reconcile prediction is bogus
    const r = new Reconciler(world, 'p');

    // Buffer thrust inputs for ticks 1..9.
    for (let t = 1; t <= 9; t++) {
      r.recordInput({ tick: t, thrust: true, turnLeft: false, turnRight: false, sentAt: 0 });
    }

    // Authoritative server state at serverTick; ackedTick 0, currentTick 10.
    const serverState: ShipPhysicsState = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
    let perReplayCalls = 0;

    r.reconcile(serverState, /*serverTick*/ 10, /*currentTick*/ 10, /*ackedTick*/ 0, () => {
      perReplayCalls++;
    });

    // Replay window is [max(ackedTick+1, currentTick-BUFFER_SIZE), currentTick)
    // = [1, 10) ⇒ exactly 9 replayed ticks, so the remote-replay hook the
    // orchestrator wires `applyRemoteInputs()` into fires 9 times.
    expect(perReplayCalls).toBe(9);

    // Player was rolled back to (0,0) then thrust-replayed 9 ticks — it must
    // have moved off the server pose along thrust (+Y in World), proving the
    // roll-back + input replay path is intact (NOT pinned at serverState,
    // NOT left at the bogus 999,999 pre-reconcile prediction).
    const after = world.getShipState('p')!;
    expect(after.y).toBeGreaterThan(0.5);
    expect(Math.abs(after.x)).toBeLessThan(50);
    expect(Math.hypot(after.x - 999, after.y - 999)).toBeGreaterThan(100);
    // Telemetry the reconciler exposes for the dev overlay still populated.
    expect(r.lastServerState).toEqual({ x: 0, y: 0 });
  });

  it('with no buffered inputs still fires perReplayTick per tick (remote-only replay)', () => {
    world.despawnShip('p2');
    world.spawnShip('p2', 10, 10);
    const r = new Reconciler(world, 'p2');
    let calls = 0;
    // ackedTick 5, currentTick 8 ⇒ replay [6,8) ⇒ 2 ticks, no local inputs
    // buffered: the hook still fires so remote ships forward-predict.
    r.reconcile({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 8, 8, 5, () => { calls++; });
    expect(calls).toBe(2);
  });
});
