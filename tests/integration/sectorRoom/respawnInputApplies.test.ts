/**
 * Server-side respawn cleanliness lock — written 2026-05-31 to localise
 * the "pinning after respawn" bug reported in capture
 * `2026-05-31T15-36-08Z-7eqj1a`.
 *
 * User report: "thrusts and moves are ignored, I'm pinned to the spot"
 * after respawning via galaxy-map sector-pick. Capture analysis showed
 * `predState.x/y` identical to 3 decimal places across 2.4 s of fire
 * events post-respawn; correction data confirmed the server's
 * authoritative pose at (653.984, 513.461) with vx=vy=0 even 23 ticks
 * AFTER `arrivalTick`.
 *
 * This test exercises the server-side respawn pipeline in isolation:
 *   1. Player joins fresh, sends `client_ready`, ship activates
 *   2. Baseline: thrust input → snapshot pose changes
 *   3. Player disconnects (galaxy room lingers the ship)
 *   4. Player rejoins with `isNewShip: true` (the path galaxy-map
 *      sector-pick takes — fresh-spawn displacing the lingering hull)
 *   5. Player sends client_ready again, ship activates
 *   6. Thrust input applied for ~1 s
 *   7. Snapshot pose changes by > 1 u
 *
 * **Test outcome (2026-05-31): BOTH cases PASS.** That is the load-bearing
 * finding — the server-side respawn pipeline is clean. The bug does NOT
 * live in:
 *   - Server input handler (no isActive gate; inputs always reach worker)
 *   - Worker SPAWN / DESPAWN around respawn (body exists, applies impulses)
 *   - isActive flip at arrivalTick (handshake completes correctly)
 *   - playerToSlot mapping post-rejoin (slot resolves, input lands)
 *
 * Per Invariant #13 this is the "test was at the wrong level" outcome.
 * The bug lives **client-side** in the dispose cascade — capture data
 * showed 4× `client_constructed` events vs only 3× `dispose_complete`
 * across 2 respawn cycles (one orphaned ColyseusGameClient). With an
 * orphaned client still alive, the `getGameClient()` singleton resolution
 * + keyboard handler binding can route inputs to the disposed client's
 * dead room reference instead of the live one. Server never sees them.
 *
 * This test stays as a regression lock for the server side — if a future
 * refactor breaks isActive-flip-at-arrival or worker SPAWN-after-respawn,
 * one of these two cases will fail loudly.
 *
 * Sibling work for the client-side cascade: see
 * `tests/e2e/respawn-cascade-input-routing.spec.ts` (TBD — needs a
 * Playwright spec that drives the galaxy-map sector-pick flow and
 * asserts `data-ship-positions` changes after the second respawn).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { Room as ClientRoom } from 'colyseus.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

interface PoseSample {
  shipInstanceId: string;
  playerId: string;
  isActive: boolean;
  x: number;
  y: number;
}

function collectPoses(room: ClientRoom<SectorState>, target: PoseSample[]): void {
  room.onMessage('snapshot', (snap: unknown) => {
    const s = snap as SnapshotMessage;
    for (const [shipInstanceId, entry] of Object.entries(s.states)) {
      target.push({
        shipInstanceId,
        playerId: entry.playerId,
        isActive: entry.isActive,
        x: entry.x,
        y: entry.y,
      });
    }
  });
}

describe('SectorRoom respawn — input must move ship after rejoin', () => {
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

  it('baseline: thrust moves the ship on first spawn', async () => {
    const pid = randomUUID();
    const client = await harness.connectAs(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const poses: PoseSample[] = [];
    collectPoses(client, poses);

    client.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({
      tag: 'ship_activated',
      where: (d) => d['playerId'] === pid,
    });

    // Drive thrust for ~1 s. The first thrust wakes the sector and
    // starts snapshot broadcasts.
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(client);
      await harness.advance(50);
    }

    const myPoses = poses.filter((p) => p.playerId === pid && p.isActive);
    expect(myPoses.length, 'baseline: must receive multiple snapshots').toBeGreaterThan(5);
    const first = myPoses[0]!;
    const last = myPoses[myPoses.length - 1]!;
    const distMoved = Math.hypot(last.x - first.x, last.y - first.y);
    expect(
      distMoved,
      `baseline: ship should move under thrust on first spawn. Start (${first.x.toFixed(3)}, ${first.y.toFixed(3)}) → end (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`,
    ).toBeGreaterThan(1);

    await harness.disconnectClient(client);
  });

  it('REGRESSION: thrust moves the ship after disconnect + isNewShip rejoin', async () => {
    const pid = randomUUID();

    // ── First spawn cycle ────────────────────────────────────────────
    const client1 = await harness.connectAs(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    client1.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({
      tag: 'ship_activated',
      where: (d) => d['playerId'] === pid,
    });
    harness.events.clear();

    await harness.disconnectClient(client1);
    await harness.events.waitFor({
      tag: 'player_lingered',
      where: (d) => d['playerId'] === pid,
    });

    // ── Second spawn cycle (isNewShip = galaxy-map sector-pick path) ─
    const client2 = await harness.connectAs(pid, {
      shipKind: 'fighter',
      isNewShip: true,
      spawnX: 100,
      spawnY: 100,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    const poses: PoseSample[] = [];
    collectPoses(client2, poses);

    client2.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({
      tag: 'ship_activated',
      where: (d) => d['playerId'] === pid,
    });

    // Drive thrust for ~1 s.
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(client2);
      await harness.advance(50);
    }

    // Filter for the ACTIVE ship for this player. The lingering hull
    // (isActive=false) will also appear in snapshots; we want the new
    // active one.
    const myActivePoses = poses.filter((p) => p.playerId === pid && p.isActive);

    expect(
      myActivePoses.length,
      'after rejoin, must receive at least 5 active-ship snapshots',
    ).toBeGreaterThan(5);

    const first = myActivePoses[0]!;
    const last = myActivePoses[myActivePoses.length - 1]!;
    const distMoved = Math.hypot(last.x - first.x, last.y - first.y);

    expect(
      distMoved,
      [
        'After disconnect + isNewShip rejoin, thrust must move the ship.',
        `Movement observed: ${distMoved.toFixed(3)} u (expected > 1 u).`,
        'If 0: server treats the rejoined ship as inputs-rejected — likely',
        'inputs routed to the wrong slot (stale playerToSlot mapping), or',
        'worker body wasn\'t spawned for the new ship.',
        `First active snapshot: (${first.x.toFixed(3)}, ${first.y.toFixed(3)})`,
        `Last active snapshot:  (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`,
        `Total snapshots seen for this player: ${myActivePoses.length}`,
      ].join('\n'),
    ).toBeGreaterThan(1);

    await harness.disconnectClient(client2);
  });

  it('REBIND: thrust moves the ship after disconnect + rejoin WITHOUT isNewShip', async () => {
    // User smoke report (2026-06-03): "Spawned as an interceptor in Sol.
    // Went back to menu. Spawned in as another interceptor... Instead
    // respawned me in that same interceptor and I couldn't move."
    //
    // The galaxy-map "resume / rejoin same sector" path (no isNewShip)
    // rebinds the player to their lingering hull via the SectorRoom `else`
    // branch (pendingJoin → client_ready → warp_in → arrivalTick). This
    // exercises the SERVER side of that rebind: after the handshake the
    // ship must accept input and move. If the server is clean here, the
    // "can't move" bug lives client-side (the rebound ship stuck in the
    // lingering-hull mirror / predWorld not re-seeded).
    const pid = randomUUID();

    const client1 = await harness.connectAs(pid, { shipKind: 'interceptor', spawnX: 0, spawnY: 0 });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    client1.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({ tag: 'ship_activated', where: (d) => d['playerId'] === pid });
    harness.events.clear();

    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });

    // Rejoin WITHOUT isNewShip → the server's rebind (else) branch.
    const client2 = await harness.connectAs(pid, { shipKind: 'interceptor' });
    // The rebind path emits `player_rebind`, NOT `player_join`.
    await harness.events.waitFor({ tag: 'player_rebind', where: (d) => d['playerId'] === pid });
    const poses: PoseSample[] = [];
    collectPoses(client2, poses);

    client2.send('client_ready', { type: 'client_ready' });
    await harness.events.waitFor({ tag: 'ship_activated', where: (d) => d['playerId'] === pid });

    for (let i = 0; i < 20; i++) {
      harness.sendThrust(client2);
      await harness.advance(50);
    }

    const myActivePoses = poses.filter((p) => p.playerId === pid && p.isActive);
    expect(myActivePoses.length, 'after rebind, must receive active-ship snapshots').toBeGreaterThan(5);
    const first = myActivePoses[0]!;
    const last = myActivePoses[myActivePoses.length - 1]!;
    const distMoved = Math.hypot(last.x - first.x, last.y - first.y);
    expect(
      distMoved,
      [
        'After disconnect + rebind (no isNewShip), thrust must move the ship.',
        `Movement observed: ${distMoved.toFixed(3)} u (expected > 1 u).`,
        `First: (${first.x.toFixed(3)}, ${first.y.toFixed(3)}) Last: (${last.x.toFixed(3)}, ${last.y.toFixed(3)})`,
      ].join('\n'),
    ).toBeGreaterThan(1);

    await harness.disconnectClient(client2);
  });
});
