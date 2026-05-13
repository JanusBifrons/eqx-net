/**
 * Phase A2 — integration test for Phase 6b lingering-hull visibility.
 *
 * Regression lock for the bug class that bit Phase 6b multiple times:
 * a player disconnects, reconnects with a fresh ship, the old hull is
 * supposed to remain visible. Three things must line up:
 *
 *   1. Server: lingering hull stays in `state.ships` with `isActive=false`
 *      after disconnect; slot moves to `lingeringSlots` on fresh-spawn-displace.
 *   2. Server: snapshot broadcast iterates BOTH `playerToSlot` (active) AND
 *      `lingeringSlots` (lingering).
 *   3. Client: snapshot's `isActive=false` entries route to
 *      `mirror.lingeringShips` rather than overwriting active mirror entries.
 *
 * Item (3) is covered by `src/client/net/ColyseusClient.lingeringRouting.test.ts`.
 * This integration test covers items (1) and (2) end-to-end against a
 * real SectorRoom + Colyseus broadcast pipeline.
 *
 * Test isolation: each test gets its own server + port via `beforeEach`.
 * Galaxy rooms (`sectorKey: 'sol-prime'`) are `autoDispose=false` so
 * lingering hulls persist across the disconnect/reconnect cycle within
 * a single test — but cross-test state pollution would be a footgun.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

/** The server's `assignPlayerId` rejects non-UUID join options for security.
 *  Tests use real UUIDs and assert against the same value end-to-end. */
const PID_A = randomUUID();
const PID_B = randomUUID();
const PID_C = randomUUID();
const PID_D = randomUUID();
const PID_E = randomUUID();

describe('SectorRoom integration — Phase 6b lingering hulls', () => {
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

  it('after onJoin, state.ships has the active hull with isActive=true', async () => {
    const client = await harness.connectAs(PID_A, { shipKind: 'fighter' });
    await harness.advance(150);
    const room = harness.getServerRoom();
    expect(room).not.toBeNull();
    const state = room!.state as SectorState;
    expect(state.ships.size).toBe(1);
    const [shipInstanceId, ship] = [...state.ships.entries()][0]!;
    expect(typeof shipInstanceId).toBe('string');
    expect(shipInstanceId.length).toBeGreaterThan(0);
    expect(ship.playerId).toBe(PID_A);
    expect(ship.isActive).toBe(true);
    expect(ship.alive).toBe(true);
    await harness.disconnectClient(client);
  });

  it('the schema map key matches each entry\'s shipInstanceId (rekey lock)', async () => {
    const client = await harness.connectAs(PID_B);
    await harness.advance(150);
    const state = harness.getServerRoom()!.state as SectorState;
    for (const [key, ship] of state.ships.entries()) {
      expect(key).toBe(ship.shipInstanceId);
    }
    await harness.disconnectClient(client);
  });

  it('after disconnect from galaxy room, ship lingers with isActive=false', async () => {
    const client = await harness.connectAs(PID_C, { shipKind: 'scout' });
    await harness.advance(150);
    const state = harness.getServerRoom()!.state as SectorState;
    expect(state.ships.size).toBe(1);
    const [originalShipId] = [...state.ships.entries()][0]!;

    await harness.disconnectClient(client);
    await harness.advance(300);

    expect(state.ships.size).toBe(1);
    const lingeringShip = state.ships.get(originalShipId);
    expect(lingeringShip).toBeDefined();
    expect(lingeringShip!.isActive).toBe(false);
    expect(lingeringShip!.playerId).toBe(PID_C);
  });

  it('snapshot wire format: keys are shipInstanceId; entries carry playerId + isActive', async () => {
    const client = await harness.connectAs(PID_D, { shipKind: 'scout' });
    // Wake the sector — broadcasts are suppressed while idle. Thrust
    // applies an impulse → shipPoseCache shows motion → noteSectorEvent
    // → sectorIdle=false → broadcast loop fires.
    harness.sendThrust(client);
    const snap = await harness.waitForSnapshot(client, 3000);
    expect(snap.type).toBe('snapshot');
    const keys = Object.keys(snap.states);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const entry = snap.states[key]!;
      expect(typeof entry.playerId).toBe('string');
      expect(entry.playerId.length).toBeGreaterThan(0);
      expect(typeof entry.isActive).toBe('boolean');
      // Phase 6a contract: outer key MUST NOT equal playerId (proves the
      // wire format isn't regressing back to playerId keying).
      expect(key).not.toBe(entry.playerId);
    }
    await harness.disconnectClient(client);
  });

  it('after fresh-spawn (isNewShip), original ship lingers + new ship is active', async () => {
    // Step 1: spawn the original ship.
    const client1 = await harness.connectAs(PID_E, { shipKind: 'fighter' });
    await harness.advance(150);
    const state = harness.getServerRoom()!.state as SectorState;
    expect(state.ships.size).toBe(1);
    const [originalShipId, originalShip] = [...state.ships.entries()][0]!;
    expect(originalShip.isActive).toBe(true);

    // Step 2: disconnect (triggers linger).
    await harness.disconnectClient(client1);
    await harness.advance(300);
    expect(state.ships.size).toBe(1);
    expect(state.ships.get(originalShipId)!.isActive).toBe(false);

    // Step 3: reconnect with isNewShip — should add a new active hull
    // alongside the existing lingering one.
    const client2 = await harness.connectAs(PID_E, {
      isNewShip: true,
      shipKind: 'scout',
    });
    await harness.advance(200);

    expect(state.ships.size).toBe(2);
    let activeCount = 0;
    let lingeringCount = 0;
    for (const ship of state.ships.values()) {
      expect(ship.playerId).toBe(PID_E);
      if (ship.isActive) activeCount++;
      else lingeringCount++;
    }
    expect(activeCount).toBe(1);
    expect(lingeringCount).toBe(1);

    // The original ship's shipInstanceId still resolves; lingering side.
    expect(state.ships.get(originalShipId)!.isActive).toBe(false);
    await harness.disconnectClient(client2);
  });
});
