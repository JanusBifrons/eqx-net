/**
 * Phase 4 WS-A2 — SAME-SECTOR INSTANT ship swap via the in-world `pilot_ship`
 * message. A player who is a spectator (their hull died) — or who is piloting a
 * different hull — reclaims one of their OWN lingering hulls parked in this
 * sector and resumes control of it IN-ROOM, with no leave/rejoin (no spool, no
 * curtain). The server rebinds control reusing the lingering-hull reactivation
 * machinery + `RosterPersistence.markActive`, preserving the rekey/abandon
 * identity invariant.
 *
 * REPRODUCE-FIRST (Invariant #13): the `lingering*`/`transit`/`abandon` greens
 * were run as a baseline BEFORE this WS was implemented. This is the failing-
 * first lock for the NEW behaviour — on the pre-WS-A2 server there is no
 * `pilot_ship` handler, so the lingering hull never reactivates and these
 * assertions fail.
 *
 * Acceptance covered here (server-authoritative slice):
 *   1. Pilot transfers control — a lingering hull → the player's ACTIVE hull.
 *   2. Lingering re-entry lands at its LIVE pose (not a stale abandon pose).
 *   3. Cannot pilot ANOTHER player's piloted ship — a foreign / active hull
 *      request is dropped (no control transfer, no clobber).
 *   4. The rekey/abandon identity invariant is preserved: the reclaimed hull's
 *      lingering bookkeeping (`lingeringSlots` / `ownerlessShips`) is torn down,
 *      and its roster row survives owned + active.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

interface Sample {
  id: string;
  playerId: string;
  x: number;
  y: number;
  isActive: boolean;
}

function collect(
  room: { onMessage: (t: string, cb: (s: unknown) => void) => void },
  target: Sample[],
): void {
  room.onMessage('snapshot', (snap: unknown) => {
    const s = snap as SnapshotMessage;
    for (const [id, e] of Object.entries(s.states)) {
      target.push({ id, playerId: e.playerId, x: e.x, y: e.y, isActive: e.isActive });
    }
  });
}

describe('SectorRoom integration — WS-A2 same-sector pilot swap', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('pilot_ship reactivates a DISPLACED lingering hull in the SAME room — control transfers, no leave', async () => {
    const pid = randomUUID();

    // 1) Spawn fighter B at (0,0), active.
    const client1 = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;
    let bId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { bId = s.shipInstanceId; break; }
    }
    expect(bId).not.toBe('');

    // 2) Disconnect → B lingers; reconnect isNewShip → scout C active, B displaced
    //    into lingeringSlots (`linger-<bId>` body, ownerless marker). This is the
    //    realistic "I have a parked ship of mine in this sector" precondition.
    await harness.disconnectClient(client1);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    const client2 = await harness.connectActive(pid, { isNewShip: true, shipKind: 'scout', spawnX: 400, spawnY: 400 });
    expect(internals.lingeringSlots.has(bId)).toBe(true);
    expect(internals.ownerlessShips.has(bId)).toBe(true);
    let cId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { cId = s.shipInstanceId; break; }
    }
    expect(cId).not.toBe('');
    expect(cId).not.toBe(bId);

    // 3) WHILE STILL IN THE ROOM (no disconnect), the player pilots B.
    const samples: Sample[] = [];
    collect(client2, samples);
    client2.send('pilot_ship', { type: 'pilot_ship', shipId: bId });
    // client_ready is required for the handshake to flip isActive=true. Allow >
    // ARRIVAL_OFFSET_TICKS (36 ticks ≈ 600 ms) for the drain to activate.
    client2.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);

    // THE LOCK: B is now the player's ACTIVE hull (control transferred in-room).
    const bShip = state.ships.get(bId);
    expect(bShip).toBeDefined();
    expect(bShip!.isActive, 'B reactivated as the active hull').toBe(true);
    expect(bShip!.playerId).toBe(pid);
    expect(bShip!.health).toBeGreaterThan(0);
    // Identity invariant: B's lingering bookkeeping is torn down on reclaim.
    expect(internals.lingeringSlots.has(bId), 'B is no longer a lingering slot').toBe(false);
    expect(internals.ownerlessShips.has(bId), 'B ownerless marker cleared').toBe(false);
    // The roster row for B survives, owned + active.
    const rec = getPlayerShipStore().get(bId);
    expect(rec).not.toBeNull();
    expect(rec!.playerId).toBe(pid);

    await harness.disconnectClient(client2);
  }, 30_000);

  it('pilot_ship lands the reclaimed hull at its LIVE (bumped) pose, not the abandon pose', async () => {
    const PID_A = randomUUID();
    const PID_B = randomUUID();

    // A spawns X at (0,0); swaps to a fresh Y so X is displaced into the world.
    const aX = await harness.connectActive(PID_A, { spawnX: 0, spawnY: 0, shipKind: 'fighter' });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let shipX = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === PID_A && ship.isActive) { shipX = ship.shipInstanceId; break; }
    }
    expect(shipX).not.toBe('');
    await harness.disconnectClient(aX);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID_A });
    const aY = await harness.connectActive(PID_A, { isNewShip: true, shipKind: 'fighter', spawnX: 600, spawnY: 600 });

    // B pushes the parked X off (0,0).
    const samples: Sample[] = [];
    const b = await harness.connectActive(PID_B, { spawnX: 0, spawnY: -25, shipKind: 'fighter' });
    collect(b, samples);
    for (let i = 0; i < 20; i++) {
      harness.sendThrust(b);
      await harness.advance(50);
    }
    const xLinger = samples.filter((s) => s.id === shipX && !s.isActive);
    expect(xLinger.length).toBeGreaterThan(5);
    const liveBump = xLinger[xLinger.length - 1]!;
    expect(liveBump.y, 'precondition: X must be pushed off (0,0)').toBeGreaterThan(5);

    // A pilots BACK to X IN-ROOM (no disconnect) — the same-sector swap.
    samples.length = 0;
    collect(aY, samples);
    aY.send('pilot_ship', { type: 'pilot_ship', shipId: shipX });
    aY.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);

    // THE LOCK: A re-enters X at its LIVE post-bump pose, not the (0,0) abandon pose.
    const aActiveOnX = samples.filter((s) => s.id === shipX && s.playerId === PID_A && s.isActive);
    expect(aActiveOnX.length).toBeGreaterThan(0);
    const reentered = aActiveOnX[aActiveOnX.length - 1]!;
    expect(
      reentered.y,
      `re-entered X at y=${reentered.y.toFixed(1)} but the live bumped hull was at y=${liveBump.y.toFixed(1)} — ` +
        `the pilot swap read the stale abandon pose`,
    ).toBeGreaterThan(liveBump.y - 12);

    await harness.disconnectClient(aY);
    await harness.disconnectClient(b);
  }, 35_000);

  it('pilot_ship for ANOTHER player’s active hull is DROPPED — no control transfer, no clobber', async () => {
    const PID_A = randomUUID();
    const PID_B = randomUUID();

    const a = await harness.connectActive(PID_A, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const b = await harness.connectActive(PID_B, { shipKind: 'fighter', spawnX: 300, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    let bShipId = '';
    let aShipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === PID_B && s.isActive) bShipId = s.shipInstanceId;
      if (s.playerId === PID_A && s.isActive) aShipId = s.shipInstanceId;
    }
    expect(bShipId).not.toBe('');
    expect(aShipId).not.toBe('');

    // A tries to pilot B's ACTIVE, piloted hull — must be rejected.
    a.send('pilot_ship', { type: 'pilot_ship', shipId: bShipId });
    await harness.advance(300);

    // B's hull is unchanged: still owned by B, still active, A did NOT take it.
    const bShip = state.ships.get(bShipId)!;
    expect(bShip.playerId).toBe(PID_B);
    expect(bShip.isActive).toBe(true);
    // A is still on its OWN hull (the request was a no-op for A).
    expect(state.ships.get(aShipId)!.playerId).toBe(PID_A);
    expect(state.ships.get(aShipId)!.isActive).toBe(true);

    await harness.disconnectClient(a);
    await harness.disconnectClient(b);
  }, 30_000);
});
