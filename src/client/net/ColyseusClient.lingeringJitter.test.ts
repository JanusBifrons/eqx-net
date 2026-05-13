/**
 * Regression: lingering hull "jitters between two locations" after
 * collision (2026-05-13 smoke-test bug, follow-up to commit `2578eda`).
 *
 * USER REPORTED (verbatim):
 *   "after I hit the lingering ship, it'll sort of jitters between two
 *   locations. We had exactly the same bug with the AI, and I think the
 *   fix was that when you're within the range of interest shedding, you
 *   just honor the pred or something along those lines."
 *
 * The user is pointing at the AI-lockstep dual-correction-path bug
 * (`docs/architecture/ai-lockstep.md`): two paths writing to the same
 * predicted state surface fight each other. For lingering hulls, the
 * two paths are:
 *
 *   PATH A — `handleSnapshot`: every snapshot (20 Hz). Writes
 *     `mirror.lingeringShips[id].x/y` from `SnapshotMessage.states[id]`
 *     and calls `tryEnsureLingerPredBody` to teleport the predWorld
 *     body to that pose + capture a spring-decayed sprite offset.
 *
 *   PATH B — `syncMirror`: every `onStateChange` (fires whenever ANY
 *     Colyseus schema field mutates — `state.tick` updates every
 *     server tick, so this happens at ~60 Hz). Re-writes
 *     `mirror.lingeringShips[id]` from the schema diff (preserving
 *     `prev.x/y` from PATH A) AND calls `tryEnsureLingerPredBody`,
 *     which teleports the predWorld body back to that (now-stale)
 *     pose + captures another offset.
 *
 * Between snapshots, the body integrates forward under collision push
 * (the Phase 6b push fix lets the server-authoritative pose update,
 * but the client also predicts forward locally for visual smoothness
 * via predWorld physics). PATH B's repeated teleport YANKS the body
 * back to the last-snapshot pose every ~16 ms. The user sees the
 * sprite oscillate between predicted-forward and snapshot-anchor
 * positions.
 *
 * THE FIX (matching the AI lockstep chapter-2 fix): one correction
 * path per state surface. `handleSnapshot` is the canonical correction
 * path for lingering hull poses — it owns spawn + ongoing reconcile.
 * `syncMirror` is for identity (kind, displayName, isActive) only;
 * its call to `tryEnsureLingerPredBody` should ONLY spawn on first
 * observation (race fallback when the schema diff arrives before the
 * first snapshot). Once the body exists, syncMirror must NOT touch
 * the body's pose.
 *
 * THIS TEST drives the bug scenario in isolation: handleSnapshot at
 * pose P0, simulated forward integration to P0+δ, syncMirror fires,
 * and asserts the body is STILL at P0+δ (not teleported back to P0).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface Internals {
  handleSnapshot(snap: SnapshotMessage): void;
  syncMirror(state: unknown): void;
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    lingeringShips?: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string }>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function snapshotWithLingering(shipInstanceId: string, x: number, y: number): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 100,
    ackedTick: 0,
    states: {
      [shipInstanceId]: {
        x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
        playerId: 'player-owner',
        isActive: false,
      },
    },
  };
}

/** A schema-shaped object that mimics Colyseus's `state.ships` map
 *  for `syncMirror`. Only the fields `syncMirror` reads on the
 *  lingering branch are populated; everything else is omitted. */
function stateWithLingering(shipInstanceId: string): { ships: Map<string, Record<string, unknown>> } {
  const ships = new Map<string, Record<string, unknown>>();
  ships.set(shipInstanceId, {
    playerId: 'player-owner',
    shipInstanceId,
    isActive: false,
    alive: true,
    kind: 'fighter',
    displayName: 'lingering',
  });
  return { ships };
}

describe('lingering hull: snapshot is the sole correction path (no dual-path jitter)', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    if (!internals.mirror.lingeringShips) {
      internals.mirror.lingeringShips = new Map();
    }
    // Seed kind so tryEnsureLingerPredBody's "kind required" gate doesn't
    // bail. In real flow this is populated by the first syncMirror call.
    internals.mirror.lingeringShips.set('SHIP_X', {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter',
    });
  });

  it('syncMirror does NOT reset body pose after handleSnapshot has spawned it', async () => {
    // 1. First snapshot — body spawns at (50, 50).
    internals.handleSnapshot(snapshotWithLingering('SHIP_X', 50, 50));
    expect(internals.predWorld!.hasShip('linger-SHIP_X')).toBe(true);
    const pose0 = internals.predWorld!.getShipState('linger-SHIP_X')!;
    expect(pose0.x).toBeCloseTo(50, 1);
    expect(pose0.y).toBeCloseTo(50, 1);

    // 2. Simulate the predicted body integrating forward under
    //    collision push (Phase 6b: the active ship just rammed it).
    //    Position now at (75, 50) — 25 units ahead of where the
    //    snapshot anchor said.
    internals.predWorld!.setShipState('linger-SHIP_X', {
      x: 75, y: 50, vx: 50, vy: 0, angle: 0, angvel: 0,
    });

    // 3. syncMirror fires (Colyseus state diff — could be anything,
    //    even a totally unrelated field like `state.tick` mutating).
    //    The state-diff handler iterates the ships map and re-runs
    //    `tryEnsureLingerPredBody`. The buggy path would teleport
    //    the body back to mirror.lingeringShips[id].x/y (which is
    //    the LAST snapshot pose, (50, 50)).
    internals.syncMirror(stateWithLingering('SHIP_X'));

    // 4. Body should still be at (75, 50) — syncMirror is identity-
    //    only; the snapshot path owns pose corrections.
    const poseAfterSync = internals.predWorld!.getShipState('linger-SHIP_X')!;
    expect(
      poseAfterSync.x,
      [
        `Body pose was reset by syncMirror — this is the dual-correction-`,
        `path jitter bug. Two paths writing to the lingering hull's`,
        `predWorld pose. Snapshot path is the canonical correction; the`,
        `syncMirror path must be identity-only after the body exists.`,
        ``,
        `Expected body at (75, 50) — where the predicted integration left`,
        `it after the simulated collision push.`,
        `Actual:  (${poseAfterSync.x.toFixed(3)}, ${poseAfterSync.y.toFixed(3)})`,
        ``,
        `Fix: gate syncMirror's tryEnsureLingerPredBody call to "spawn`,
        `only if !predWorld.hasShip(bodyId)" — the snapshot path handles`,
        `the ongoing pose updates, like the AI-lockstep snapshot-anchor`,
        `gates the binary-swarm-packet setShipState for in-snapshot drones.`,
      ].join('\n'),
    ).toBeCloseTo(75, 1);
    expect(poseAfterSync.y).toBeCloseTo(50, 1);
  });

  it('syncMirror still spawns the body if it arrives BEFORE the first snapshot (race fallback)', async () => {
    // Race scenario: Colyseus state patch arrives before the first
    // snapshot. syncMirror should spawn a body so the local player can
    // collide with it even in this window. Pose is best-effort (whatever
    // prev?.x/y has — usually (0, 0)); the first snapshot will reconcile.
    internals.syncMirror(stateWithLingering('SHIP_X'));
    expect(internals.predWorld!.hasShip('linger-SHIP_X')).toBe(true);
  });
});
