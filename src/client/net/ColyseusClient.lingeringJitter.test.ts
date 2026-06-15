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

  it('syncMirror does NOT spawn a lingering body at origin before the first snapshot (no (0,0) ghost); the snapshot path spawns it at the real pose', async () => {
    // INVERTED 2026-06-03 (laser "ghost at (0,0)" smoke bug). The
    // lingering mirror entry is seeded at (0,0) by the schema-diff path
    // (ColyseusClient.syncMirror) until a snapshot fills the real pose.
    // The OLD behaviour spawned the predWorld body immediately from that
    // (0,0) seed as a "race fallback", parking an invisible, shootable
    // body at world origin — the on-device "laser beam stops short at
    // (0,0), no damage" ghost. It is INTERMITTENT because it only exists
    // in the schema-diff-before-first-snapshot window.
    //
    // NEW contract — the body spawns ONLY from the snapshot path
    // (snapshotShipRouter.routeSnapshotShipStates), which always carries
    // the authoritative pose; syncMirror is identity-only (single-spawn-site).
    // Why this is safe: ships are NOT interest-filtered and snapshots flow
    // at 20 Hz while a client is connected, so the no-body window is one
    // ~50 ms snapshot interval; AND a hull with no authoritative pose has
    // no known position to collide with anyway. The old race-fallback
    // spawned the body at ORIGIN, not at the hull, so it never even
    // achieved its stated "don't fly through my freshly-displaced hulk"
    // goal — it just created the (0,0) ghost.

    // 1. Schema diff arrives (kind known) but no snapshot pose yet.
    internals.syncMirror(stateWithLingering('SHIP_X'));
    expect(
      internals.predWorld!.hasShip('linger-SHIP_X'),
      [
        'syncMirror spawned a lingering predWorld body before any snapshot',
        'pose arrived — it sits at the seeded (0,0), an invisible body the',
        'local live-beam ray stops on (the "laser ghost at origin" bug).',
        'Fix: remove syncMirror\'s tryEnsureLingerPredBody spawn and let the',
        'snapshot path (which carries the real pose) be the SOLE spawn site.',
      ].join('\n'),
    ).toBe(false);

    // 2. First snapshot carries the authoritative pose → body spawns
    //    there, never at origin.
    internals.handleSnapshot(snapshotWithLingering('SHIP_X', 120, 80));
    expect(internals.predWorld!.hasShip('linger-SHIP_X')).toBe(true);
    const pose = internals.predWorld!.getShipState('linger-SHIP_X')!;
    expect(pose.x).toBeCloseTo(120, 1);
    expect(pose.y).toBeCloseTo(80, 1);
  });
});
