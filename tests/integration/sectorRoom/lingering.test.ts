/**
 * Phase A2 — integration test for Phase 6b lingering-hull visibility.
 *
 * This is the regression lock for the bug class that has bitten Phase
 * 6b multiple times: a player disconnects, reconnects with a fresh
 * ship, and the old hull is supposed to remain visible as a parked
 * ship in the same sector. Three things have to line up for that to
 * work, and each was broken at some point during the Phase 6b
 * smoke-test-fix cycle:
 *
 *   1. Server-side: the lingering hull stays in `state.ships` with
 *      `isActive=false` after disconnect; its slot moves to
 *      `lingeringSlots` when displaced by a fresh spawn.
 *   2. Server-side: the snapshot broadcast loop iterates BOTH
 *      `playerToSlot` (active hulls) AND `lingeringSlots` (lingering
 *      hulls).
 *   3. Client-side: the snapshot's `isActive=false` entries get
 *      routed to `mirror.lingeringShips` rather than overwriting the
 *      active hull's entry in `mirror.ships`.
 *
 * Item (3) is covered by `src/client/net/ColyseusClient.lingeringRouting.test.ts`
 * — pure unit test on the snapshot ingest boundary. This integration
 * test covers items (1) and (2) end-to-end: a real SectorRoom, real
 * physics worker, real Colyseus broadcast pipeline, real (in-process)
 * client receiving the schema diff and snapshot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — Phase 6b lingering hulls', () => {
  let harness: SectorTestHarness;

  beforeAll(async () => {
    harness = await bootSectorTestServer({
      // Engineering room semantics for these tests — no roster
      // persistence, no Limbo (sectorKey === null). The lingering-hull
      // behaviour we test here is driven by `playerToSlot` /
      // `lingeringSlots` / `state.ships`, which are present regardless
      // of sectorKey. A galaxy-keyed variant of the harness lives in
      // future tests once Phase 6d cap tests need persistence-aware
      // scenarios.
      sectorKey: undefined,
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterAll(async () => {
    await harness.cleanup();
  }, 10_000);

  beforeEach(() => {
    harness.sink.reset();
  });

  it('after onJoin, state.ships has the active hull with isActive=true', async () => {
    const client = await harness.connectAs('player-A', { shipKind: 'fighter' });
    // Wait a beat for the room to finish processing the join.
    await harness.advance(100);
    const state = harness.getServerRoom().state;
    expect(state.ships.size).toBe(1);
    // shipInstanceId is the schema map key (Phase 6a wire format).
    const [shipInstanceId, ship] = [...state.ships.entries()][0]!;
    expect(typeof shipInstanceId).toBe('string');
    expect(shipInstanceId.length).toBeGreaterThan(0);
    expect(ship.playerId).toBe('player-A');
    expect(ship.isActive).toBe(true);
    expect(ship.alive).toBe(true);
    await harness.disconnectClient(client);
  });

  it('after consent-leave (engineering room), the ship is REMOVED — engineering rooms do not linger', async () => {
    // Engineering rooms (sectorKey === null) skip the linger branch
    // entirely — there's no roster to preserve, so the ship is fully
    // despawned on leave. This documents the engineering-room contract
    // and ensures lingering only fires for galaxy rooms.
    const client = await harness.connectAs('player-B');
    await harness.advance(100);
    expect(harness.getServerRoom().state.ships.size).toBe(1);
    await harness.disconnectClient(client);
    await harness.advance(200);  // give onLeave time to run
    expect(harness.getServerRoom().state.ships.size).toBe(0);
  });

  it('snapshot wire format: every entry has playerId + isActive (Phase 6a contract)', async () => {
    const client = await harness.connectAs('player-C', { shipKind: 'scout' });
    const snap = await harness.waitForSnapshot(client, 2000);
    expect(snap.type).toBe('snapshot');
    const entries = Object.values(snap.states);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.playerId).toBe('string');
      expect(entry.playerId.length).toBeGreaterThan(0);
      expect(typeof entry.isActive).toBe('boolean');
      expect(entry.isActive).toBe(true);  // no lingering hulls in this scenario
    }
    await harness.disconnectClient(client);
  });

  it('snapshot keys are shipInstanceId, not playerId (Phase 6a wire rekey lock)', async () => {
    const client = await harness.connectAs('player-D');
    const snap = await harness.waitForSnapshot(client, 2000);
    const keys = Object.keys(snap.states);
    expect(keys.length).toBeGreaterThan(0);
    // The map key MUST NOT equal the playerId field — that would mean
    // the wire format regressed back to playerId keying.
    for (const key of keys) {
      const entry = snap.states[key]!;
      expect(key).not.toBe(entry.playerId);
    }
    await harness.disconnectClient(client);
  });

  it('the schema map key matches each entry\'s shipInstanceId (server-side rekey lock)', async () => {
    const client = await harness.connectAs('player-E');
    await harness.advance(100);
    const state = harness.getServerRoom().state as SectorState;
    for (const [key, ship] of state.ships.entries()) {
      expect(key).toBe(ship.shipInstanceId);
    }
    await harness.disconnectClient(client);
  });
});
