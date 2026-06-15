/**
 * Regression: lingering hull "moves then snaps back" when active ship
 * collides into it (2026-05-13 smoke-test bug, diag capture
 * 2026-05-13T19-33-59-440Z-04j2mm).
 *
 * USER REPORTED (verbatim):
 *   "When I flew into the abandoned ship, it moved as I'd expect for
 *   half a second, and then it would snap back to where to where I
 *   originally saw it. And it did that repeatedly."
 *
 * ROOT CAUSE (from forensics):
 *
 *   When the same player disconnects → reconnects with `isNewShip:true`,
 *   the fresh-spawn flow:
 *
 *     1. Promotes the player's existing slot into `lingeringSlots`
 *        (correct).
 *     2. Allocates a NEW slot for the active ship (correct).
 *     3. Sends a `SPAWN { type, slot: newSlot, playerId }` command to
 *        the physics worker (BROKEN).
 *
 *   The worker's `physics.spawnShip(playerId, ...)` calls
 *   `bodies.set(playerId, newBody)` — overwriting the OLD body's entry
 *   in `World.bodies`. The OLD Rapier body is still alive in the
 *   world (and still collidable!) but is no longer iterated by
 *   `getAllShipStates()`, so its pose is NEVER written to its SAB
 *   slot. The main thread's `lingeringPoseCache` reads the stale SAB,
 *   broadcasts the original abandon-point pose forever. Every
 *   snapshot tells the client "the hull is at X" where X never
 *   changes. Client predicts the hull moving on collision → snapshot
 *   pulls the sprite back to X → visible as fly-through-then-snap-back.
 *
 *   The fix is `REKEY_SHIP` — moving the body's lookup key from
 *   `playerId` to `linger-${shipInstanceId}` so the new SPAWN doesn't
 *   overwrite it. Phase 6b lingering hulls originally missed this rekey
 *   step.
 *
 * THIS TEST asserts the user-visible contract end-to-end against a
 * real SectorRoom + worker: after a fresh-spawn-displaces, the
 * lingering hull's SAB-broadcast pose must update when the new
 * active ship pushes into it. If the pose stays exactly equal to its
 * pre-collision value over 1 second of active-ship thrust, the
 * worker rekey is missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

const PID = randomUUID();

interface SnapshotEntry {
  x: number;
  y: number;
  vx: number;
  vy: number;
  isActive: boolean;
}

function collectSnapshots(room: { onMessage: (t: string, cb: (s: unknown) => void) => void }, target: SnapshotEntry[]): void {
  room.onMessage('snapshot', (snap: unknown) => {
    const s = snap as SnapshotMessage;
    for (const [, entry] of Object.entries(s.states)) {
      target.push({ x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy, isActive: entry.isActive });
    }
  });
}

describe('SectorRoom integration — lingering hull push (regression)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('active ship pushing into lingering hull moves the hull (server-side authority)', async () => {
    // Step 1: spawn at (0, 0) so we know the lingering hull's final
    // pose deterministically. testMode preserves spawnX/spawnY so the
    // pose is reproducible.
    const client1 = await harness.connectAs(PID, {
      spawnX: 0,
      spawnY: 0,
      shipKind: 'fighter',
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === PID });

    const state = harness.getServerRoom()!.state as SectorState;
    expect(state.ships.size).toBe(1);
    const [originalShipId] = [...state.ships.entries()][0]!;

    // Step 2: disconnect → ship lingers at (0, 0).
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID });

    // Step 3: reconnect fresh-spawn — same player, new ship, position
    // close to the lingering hull so thrust will collide it.
    // Active ship at (0, -25) facing angle 0 (forward = +y) → thrust
    // pushes it toward the lingering hull at (0, 0).
    const lingeringEntries: SnapshotEntry[] = [];
    const client2 = await harness.connectAs(PID, {
      isNewShip: true,
      shipKind: 'fighter',
      spawnX: 0,
      spawnY: -25,
    });
    collectSnapshots(client2, lingeringEntries);
    await harness.advance(150);

    expect(state.ships.size).toBe(2);
    expect(state.ships.get(originalShipId)!.isActive).toBe(false);

    // Step 4: thrust into the lingering hull for ~1 second.
    // sendThrust calls `room.send('input', { thrust:true, ... })` at
    // tick 0 (well below temporal-plausibility); the worker will
    // re-apply held input every tick under the held-input rule.
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(client2);
      await harness.advance(50);
    }

    // Filter snapshots for the LINGERING hull's pose (isActive=false).
    const lingeringSamples = lingeringEntries.filter((e) => e.isActive === false);
    expect(lingeringSamples.length).toBeGreaterThan(5);

    // Step 5: assert the lingering hull moved.
    //
    // If the server-side push is working, the hull's y should have
    // increased from ~0 toward +Y (because the active ship spawned at
    // y=-25 and thrusted toward +y, pushing the hull).
    //
    // If the worker isn't writing the lingering hull's pose to SAB,
    // every snapshot will report y ≈ 0 — within float noise — and the
    // user sees "moves then snaps back" because their client
    // predicts forward but the authoritative pose never changes.
    const first = lingeringSamples[0]!;
    const last = lingeringSamples[lingeringSamples.length - 1]!;
    const yDelta = last.y - first.y;
    const totalDriftDist = Math.hypot(last.x - first.x, last.y - first.y);

    expect(
      totalDriftDist,
      [
        `Lingering hull did not move during 1s of active-ship thrust.`,
        `First snapshot: (${first.x.toFixed(3)}, ${first.y.toFixed(3)})`,
        `Last snapshot:  (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`,
        `Drift:          ${totalDriftDist.toFixed(3)} units`,
        ``,
        `Root cause when this fails: the physics worker overwrote the`,
        `lingering hull's body entry in World.bodies when the fresh-spawn`,
        `SPAWN command was issued for the same playerId. The body is`,
        `still in Rapier but its pose is no longer being written to`,
        `the lingering slot's SAB cells. Fix: send a REKEY_SHIP command`,
        `(playerId → linger-<shipInstanceId>) at the fresh-spawn-displaces`,
        `point in SectorRoom.`,
      ].join('\n'),
    ).toBeGreaterThan(1.0); // 1 unit is well above float noise; expect tens of units
    expect(yDelta).toBeGreaterThan(0); // pushed in +y direction
    await harness.disconnectClient(client2);
  }, 20_000);
});
