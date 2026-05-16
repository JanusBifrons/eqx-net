/**
 * Regression lock for the 2026-05-16 inter-sector ARRIVAL prediction-drift
 * bug — the "warp-out is laggy for ~1 s after the curtain lifts" defect.
 *
 * Diagnostic dir-id: `diag/captures/2026-05-16T11-59-43-103Z-tl56wa`
 * (mobile, full transit timeline — 39 `transit_mark`, 120 `transit_frame`).
 * The capture's `first_snapshot` markers reported `driftUnits` of
 * **210 / 380 / 87** — the destination sector's first authoritative
 * snapshot lands hundreds of units away from the client's local
 * prediction, and `Reconciler` lerps that correction out over the first
 * ~1.3 s post-curtain (choppy 33–144 ms frames, `raf_gap`s to 344 ms).
 * That post-reveal lerp IS the jank the user feels. The ~3 s spool and
 * the 5 s minimum-display curtain floor are intentional; the drift is not.
 *
 * Root cause (read from `ColyseusClient.ts`, not theorised):
 *   - `transit_ready` (l.1085) calls `resetPredictionState()` (l.703),
 *     whose own comment (l.1104) claims the destination's first snapshot
 *     "is treated like a fresh-connect seed". That is true for the
 *     RTT/timing state it re-creates — and FALSE for the spatial body:
 *     it never despawns the local `predWorld` ship body and never nulls
 *     the `Reconciler`.
 *   - The `transit_ready` mirror-cleanup loop (l.1132-1143) explicitly
 *     PRESERVES the local ship — only remote bodies are despawned.
 *   - So at the destination, `tryInitPredWorld` (l.1370) early-returns on
 *     `predWorld.hasShip(playerId)` and the `syncMirror` reseed branch
 *     (l.2440) is skipped for the same reason. The local body arrives
 *     still at the SOURCE-sector pose; the destination's first
 *     `handleSnapshot` reconciles that stale body against the arrival
 *     pose (configurable-arrival / SAB-clamped, often hundreds of units
 *     away) ⇒ `reconciler.lastDrift` = the source→destination delta =
 *     the 210/380/87 u the instrument recorded at `ColyseusClient.ts`
 *     l.1852-1864. Intermittency = how far the arrival point landed from
 *     the pre-transit pose (configurable-arrival makes it vary).
 *
 * The fix makes `resetPredictionState()`'s documented contract TRUE for
 * the spatial body too: despawn the local predWorld body + null the
 * `Reconciler` so the destination's first state/snapshot reseeds via the
 * existing `tryInitPredWorld` path at the AUTHORITATIVE arrival pose
 * (it already rebuilds the `Reconciler` — l.1381 — and re-fires
 * `local_pose_resolved`; the latch is re-armed at l.737). One ownership
 * site, no second correction path (Invariant #12 philosophy).
 *
 * LEVEL (Invariant #13 — the level the bug LIVES, not the easiest):
 * the bug is entirely inside `ColyseusGameClient`'s own method
 * interaction (resetPredictionState ↔ preserved-local ↔ tryInitPredWorld
 * early-return ↔ handleSnapshot reconcile). It does NOT cross the
 * worker/wire boundary, so the integration harness (which uses a RAW
 * colyseus.js client and never instantiates `ColyseusGameClient`) cannot
 * observe `reconciler.lastDrift` — wrong level. A naive `Reconciler`
 * unit test would exercise reconcile MATH, not the transit-seed
 * interaction — wrong level (the damage-number "got the level wrong"
 * trap). This component test drives the REAL methods on a REAL
 * `ColyseusGameClient` with a REAL `PhysicsWorld`, in the real
 * destination-arrival order, and asserts the REAL `reconciler.lastDrift`
 * — the same metric the diagnostic recorded. Same sanctioned level as
 * `ColyseusClient.resetPredictionState.test.ts`.
 *
 * This test FAILS on the current code (drift ≈ the source→dest delta)
 * and PASSES once the fix lands. Reverting the fix re-fails it.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

// The methods + fields we drive are private. Reach in via a narrow
// structural cast so the test exercises the production code path
// verbatim (identical approach to ColyseusClient.resetPredictionState.test.ts).
// A future rename should fail to compile here — that's intentional.
interface MirrorShipLite {
  x: number; y: number; vx: number; vy: number; angle: number;
}
type Internals = {
  predWorld: PhysicsWorld | null;
  reconciler: { lastDrift: number; lastAngleDrift: number } | null;
  inputTick: number;
  mirror: { localPlayerId: string | null; ships: Map<string, MirrorShipLite> };
  tryInitPredWorld: (playerId: string) => void;
  resetPredictionState: () => void;
  handleSnapshot: (snap: SnapshotMessage) => void;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

/** Build a minimal-but-real destination first-snapshot. `states` is
 *  keyed by shipInstanceId on the wire; `handleSnapshot` translates it
 *  to a playerId-keyed view (Phase 6a). projectiles/wrecks/drones are
 *  all optional and guarded — omitting them is the real "nothing else in
 *  interest yet on the first arrival tick" case. */
function destSnapshot(playerId: string, x: number, y: number): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 1,
    ackedTick: 0,
    states: {
      [`inst-${playerId}`]: {
        x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
        playerId,
        isActive: true,
      },
    },
  };
}

describe('ColyseusGameClient — inter-sector arrival prediction drift', () => {
  it('first destination snapshot reconciles ~0 drift, not the source→dest delta', async () => {
    const PID = 'p1';
    // A realistic inter-sector arrival delta. Source pose (0,0);
    // destination arrival (300, 240) ⇒ |Δ| = hypot(300,240) ≈ 384.7 u —
    // squarely in the capture's 210/380/87 u band (the 380 sample).
    const SRC = { x: 0, y: 0 };
    const DST = { x: 300, y: 240 };

    const client = new ColyseusGameClient();
    const c = asInternals(client);
    // Real Rapier-backed prediction world (no server / WS needed — the
    // bug is the predWorld↔reconciler seeding interaction, not transport).
    c.predWorld = await PhysicsWorld.create();

    // ── 1. Source-sector connect seed ────────────────────────────────
    // Mimics the real welcome → first-state → tryInitPredWorld path:
    // local ship known + present in the mirror at the source pose.
    c.mirror.localPlayerId = PID;
    c.mirror.ships.set(PID, { ...SRC, vx: 0, vy: 0, angle: 0 });
    c.tryInitPredWorld(PID); // REAL: spawns predWorld body @ SRC + builds Reconciler
    expect(c.predWorld!.hasShip(PID)).toBe(true);
    expect(c.reconciler).not.toBeNull();
    const srcPose = c.predWorld!.getShipState(PID)!;
    expect(Math.hypot(srcPose.x - SRC.x, srcPose.y - SRC.y)).toBeLessThan(1);

    // ── 2. Transit ───────────────────────────────────────────────────
    // The exact production call from the `transit_ready` handler. (The
    // handler's WS-only steps — room.leave / consumeSeatReservation —
    // do not touch predWorld/reconciler; the mirror-cleanup loop only
    // despawns REMOTE bodies, a no-op here. So predWorld/reconciler
    // state after this call is identical to after the full handler.)
    c.resetPredictionState();

    // ── 3. Destination arrival reseed ────────────────────────────────
    // Exactly what the destination room's `syncMirror` local branch
    // (l.2440-2442) and `welcome` (l.875) do: the local mirror entry is
    // now at the AUTHORITATIVE arrival pose, then tryInitPredWorld runs.
    c.mirror.ships.set(PID, { ...DST, vx: 0, vy: 0, angle: 0 });
    c.tryInitPredWorld(PID); // REAL production reseed path

    // ── 4. Destination's first snapshot ──────────────────────────────
    c.handleSnapshot(destSnapshot(PID, DST.x, DST.y)); // REAL reconcile

    // ── Assertion: the metric the diagnostic recorded ────────────────
    // `transitInstr.markOnce('first_snapshot', { driftUnits })` reads
    // exactly `reconciler.lastDrift` (ColyseusClient.ts l.1852-1864).
    // Pre-fix: tryInitPredWorld early-returned (hasShip true) → body
    //   still @ SRC, stale Reconciler → lastDrift ≈ 384.7 (the bug).
    // Post-fix: resetPredictionState despawned the body + nulled the
    //   reconciler → step 3 reseeds @ DST + fresh Reconciler → ≈ 0.
    // Threshold 5 u ≫ float/LERP noise (0.05 u) and ≪ the 210-380 u bug.
    expect(c.reconciler).not.toBeNull();
    expect(c.reconciler!.lastDrift).toBeLessThan(5);
  });
});
