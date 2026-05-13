/**
 * Lingering-hull sprite/body sync contract (2026-05-13, third
 * iteration — predict-and-reconcile with spring-decayed lerp,
 * same pattern as remote player ships).
 *
 * Bug history:
 *   - Iter 1: sprite at snapshot pose, body integrated freely
 *     → user "flew through" the hull.
 *   - Iter 2: synced sprite TO body each frame → fixed fly-through
 *     but introduced snap-back (body drifted forward of snapshot;
 *     snapshot teleport pulled sprite back every ~50 ms).
 *   - Iter 3 (current): body integrates locally between snapshots
 *     (so the hull responds to collisions and looks alive); snapshot
 *     reconciliation teleports the body to the server-authoritative
 *     pose AND captures the (predicted - snapshot) diff as a
 *     spring-decayed sprite offset. Sprite = body + offset. Offset
 *     decays to zero over ~200 ms, so the visual smoothly converges
 *     to the server-true position instead of snapping.
 *
 * Same code shape as the remote-ship reconciler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface Internals {
  handleSnapshot(snap: SnapshotMessage): void;
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    lingeringShips?: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function makeSnapshot(states: SnapshotMessage['states']): SnapshotMessage {
  return { type: 'snapshot', serverTick: 100, states, ackedTick: 0 };
}

function lingeringEntry(playerId: string, x: number, y: number): SnapshotMessage['states'][string] {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    playerId, isActive: false,
  };
}

describe('lingering hull predict-and-reconcile with sprite lerp offset', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    // The class doesn't expose a way to inject a predWorld at
    // construction; assign directly through the internals cast.
    internals.predWorld = await PhysicsWorld.create();
    // The mirror is initialised internally; ensure the lingeringShips
    // map exists for the snapshot routing to populate.
    if (!internals.mirror.lingeringShips) {
      internals.mirror.lingeringShips = new Map();
    }
    // Lingering routing requires the entry to have a `kind` before the
    // body is spawned (`tryEnsureLingerPredBody` bails if kind missing).
    // Pre-populate via syncMirror's path: just seed the kind directly.
    internals.mirror.lingeringShips.set('SHIP_A', {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter',
    });
  });

  it('on reconcile, sprite starts at predicted pose; body teleports to snapshot pose; offset decays', () => {
    // First snapshot — body spawns at (100, 100). No prior pose, no offset.
    internals.handleSnapshot(makeSnapshot({
      'SHIP_A': lingeringEntry('player-A', 100, 100),
    }));
    expect(internals.predWorld!.hasShip('linger-SHIP_A')).toBe(true);

    // Simulate prediction integrating the body forward (e.g. after a
    // collision push). Body now at ~130, ahead of where the next
    // snapshot will say.
    internals.predWorld!.setShipState('linger-SHIP_A', {
      x: 130, y: 100, vx: 0, vy: 0, angle: 0, angvel: 0,
    });

    // Second snapshot arrives saying the server's hull is at (110,
    // 100) — closer to the original than the client predicted.
    internals.handleSnapshot(makeSnapshot({
      'SHIP_A': lingeringEntry('player-A', 110, 100),
    }));

    // Body teleports to server-authoritative pose.
    const bodyAfter = internals.predWorld!.getShipState('linger-SHIP_A')!;
    expect(bodyAfter.x).toBeCloseTo(110, 1);

    // updateMirror computes sprite position = body + offset. On the
    // reconcile frame, offset starts at preReset(130) - postReset(110) = +20.
    // Sprite should be WELL ABOVE the snapshot pose (110) so the user
    // doesn't see a teleport — and well BELOW the predicted pose (130)
    // only after the spring has had a chance to decay.
    (internals as unknown as { lastFrameMs: number }).lastFrameMs = 16; // simulate 60Hz
    internals.updateMirror();
    const mirrorEntry = internals.mirror.lingeringShips!.get('SHIP_A')!;
    expect(
      mirrorEntry.x,
      `Sprite should be near the predicted pose (130), well above the snapshot pose (110). ` +
        `Got ${mirrorEntry.x.toFixed(2)}. If this is ~110 the spring isn't being applied — user sees the teleport directly.`,
    ).toBeGreaterThan(120); // halfway between snapshot (110) and predicted (130) is the no-snap floor

    // Advance ~500 ms (30 frames at 60Hz) and call updateMirror
    // repeatedly to let the spring decay. Sprite should converge to
    // the server-authoritative body pose.
    for (let i = 0; i < 30; i++) internals.updateMirror();
    const mirrorEntryConverged = internals.mirror.lingeringShips!.get('SHIP_A')!;
    expect(
      Math.abs(mirrorEntryConverged.x - 110),
      `After ~500 ms of decay, sprite should converge to the server pose (110), got ${mirrorEntryConverged.x.toFixed(2)}.`,
    ).toBeLessThan(2);
  });
});
