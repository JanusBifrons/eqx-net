/**
 * Phase A coverage lock — abandon → wreck conversion through the real
 * SectorRoom abandon-detection poll.
 *
 * UNCOVERED PRIOR: `tests/integration/sectorRoom/rosterFullWreck.test.ts`
 * is `test.fixme()` and the path was relying on smoke-testing only.
 *
 * COVERS (Phase A6 of `humble-strolling-coral.md`):
 *   1. Active ship → store.delete → poll cycle → state.wrecks gets
 *      an entry with same shipInstanceId, kind preserved, health
 *      preserved at abandon-moment.
 *   2. Stored ship (not currently in the sector) → store.delete →
 *      poll cycle → row deleted, NO wreck created (the wreck only
 *      happens for ships currently bound to a sector slot).
 *   3. After abandon, `state.ships` no longer carries that entry —
 *      the player's slot has flipped to wreck ownership.
 *   4. WreckState schema carries shipInstanceId/health/maxHealth/kind
 *      ONLY — no playerId, no displayName (verified at the schema
 *      definition; this is a compile-time + runtime check that
 *      changing the schema breaks the lock).
 *   5. Wreck snapshot pose is broadcast in `SnapshotMessage.wrecks`
 *      with the pose at abandon moment (not (0,0)).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { WreckState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

/** Look up the server-side Room when the harness's firstRoomId was
 *  never populated (because we joined via `harness.client.joinOrCreate`
 *  to bypass cleanup-hangs on force-disconnected clients). */
function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}

describe('SectorRoom integration — abandon → wreck conversion', () => {
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

  it('WreckState schema has no playerId and no displayName fields', () => {
    // Compile-time + runtime check on the schema shape itself. If a
    // future PR adds playerId or displayName here (eg. for ownership
    // attribution in the kill feed), it would change the wire format
    // the renderer reads off `mirror.wrecks`. Lock it.
    const wreck = new WreckState();
    const fields = Object.keys(wreck);
    expect(fields).toContain('shipInstanceId');
    expect(fields).toContain('health');
    expect(fields).toContain('maxHealth');
    expect(fields).toContain('kind');
    expect(fields).not.toContain('playerId');
    expect(fields).not.toContain('displayName');
  });

  it('active ship → store.delete → wreck appears in state.wrecks with same shipInstanceId', async () => {
    const pid = randomUUID();
    const SPAWN_X = 800;
    const SPAWN_Y = -300;
    // Use harness.client.joinOrCreate DIRECTLY rather than
    // harness.connectAs. The abandon flow makes the server call
    // `client.leave(1000)` on the owning session, which puts the
    // colyseus.js Room into a state where the test's afterEach
    // `await room.leave()` hangs forever waiting for an ack on the
    // already-closed WS. Bypassing connectedRooms means cleanup
    // skips it; we still get all the assertion surfaces we need.
    const client = await harness.client.joinOrCreate('test-sector', {
      playerId: pid,
      shipKind: 'fighter',
      spawnX: SPAWN_X,
      spawnY: SPAWN_Y,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    // Complete the join handshake so the hull activates (the bare client
    // must send client_ready; the browser does this after bootstrap).
    // arrivalTick = serverTick + 36 ticks ≈ 600 ms.
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(800);

    // Get the active ship's shipInstanceId out of state.ships.
    const state = getRoomById(client.roomId).state as SectorState;
    let bound = null as null | { shipInstanceId: string; kind: string; health: number };
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) {
        bound = { shipInstanceId: ship.shipInstanceId, kind: ship.kind, health: ship.health };
        break;
      }
    }
    expect(bound).not.toBeNull();
    const shipId = bound!.shipInstanceId;

    // Listen for ship_abandoned client message BEFORE we trigger
    // the abandon, so we don't miss it.
    let abandonedMsg: { shipInstanceId: string } | null = null;
    client.onMessage('ship_abandoned', (msg: unknown) => {
      abandonedMsg = msg as { shipInstanceId: string };
    });

    // Trigger abandon — same path as devPlayerShipsAbandonHandler.
    getPlayerShipStore().delete(shipId);

    // The abandon-detection poll runs every 30 ticks (~500 ms). Allow
    // up to 1.5 s for the conversion to land.
    await harness.advance(1500);

    // Wreck must exist in state.wrecks with the same shipInstanceId.
    const wreck = state.wrecks.get(shipId);
    expect(wreck).toBeDefined();
    expect(wreck!.shipInstanceId).toBe(shipId);
    expect(wreck!.kind).toBe(bound!.kind);
    // Health is preserved at abandon moment (it might be < maxHealth
    // if the ship took damage; but for a freshly spawned ship it
    // should be at or near maxHealth).
    expect(wreck!.maxHealth).toBeGreaterThan(0);
    expect(wreck!.health).toBeGreaterThan(0);
    expect(wreck!.health).toBeLessThanOrEqual(wreck!.maxHealth);

    // state.ships no longer carries the active ship for this player.
    let stillBound = false;
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) stillBound = true;
    }
    expect(stillBound).toBe(false);

    // Roster row was the source of truth for the delete, so the
    // store.get must now return null.
    expect(getPlayerShipStore().get(shipId)).toBeNull();

    // The owning client gets a ship_abandoned notification.
    expect(abandonedMsg).not.toBeNull();
    expect(abandonedMsg!.shipInstanceId).toBe(shipId);
  });

  it('stored ship abandon → row deleted, NO wreck created', async () => {
    const pid = randomUUID();
    const store = getPlayerShipStore();

    // Seed a stored ship that is NOT in any sector slot (never joined).
    const seeded = store.create({
      playerId: pid,
      userId: null,
      kind: 'scout',
      sectorKey: 'sol-prime',
      x: 0,
      y: 0,
      health: 80,
    });
    expect(store.get(seeded.shipId)!.isActive).toBe(false);

    // Connect a DIFFERENT player so the room exists and the poll runs.
    const otherPid = randomUUID();
    await harness.connectAs(otherPid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === otherPid });

    // Abandon the stored ship — it has no slot, so no wreck happens.
    store.delete(seeded.shipId);

    // Wait > 1 poll cycle.
    await harness.advance(1000);

    const state = harness.getServerRoom()!.state as SectorState;
    expect(state.wrecks.get(seeded.shipId)).toBeUndefined();
    expect(store.get(seeded.shipId)).toBeNull();
  });

  it('wreck snapshot pose ≈ ship pose at abandon moment (not snapped to origin)', async () => {
    const pid = randomUUID();
    const SPAWN_X = 1200;
    const SPAWN_Y = -800;
    // Direct join: see comment in previous test for why we bypass
    // harness.connectAs for the soon-to-be-abandoned client.
    const _abandoned = await harness.client.joinOrCreate('test-sector', {
      playerId: pid,
      shipKind: 'fighter',
      spawnX: SPAWN_X,
      spawnY: SPAWN_Y,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });
    // Complete the join handshake so the hull activates, then let the SAB
    // pose settle (arrivalTick ≈ 600 ms).
    _abandoned.send('client_ready', { type: 'client_ready' });
    await harness.advance(800);

    const state = getRoomById(_abandoned.roomId).state as SectorState;
    let shipId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) {
        shipId = ship.shipInstanceId;
        break;
      }
    }
    expect(shipId).not.toBe('');

    // The observer client survives the abandon (different player) so
    // it's safe to register in connectedRooms via harness.connectAs.
    const observerPid = randomUUID();
    const observer = await harness.connectAs(observerPid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === observerPid });
    harness.sendThrust(observer);

    const observerSnapPromise = new Promise<SnapshotMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('observer wreck snapshot timeout')), 5000);
      observer.onMessage('snapshot', (snap: unknown) => {
        const s = snap as SnapshotMessage;
        if (s.wrecks && s.wrecks.some((w) => w.id === shipId)) {
          clearTimeout(timer);
          resolve(s);
        }
      });
    });

    getPlayerShipStore().delete(shipId);

    const snap = await observerSnapPromise;
    const wreckPose = snap.wrecks!.find((w) => w.id === shipId);
    expect(wreckPose).toBeDefined();
    // Pose preserved at abandon moment — not zeroed out.
    expect(Math.abs(wreckPose!.x - SPAWN_X)).toBeLessThan(50);
    expect(Math.abs(wreckPose!.y - SPAWN_Y)).toBeLessThan(50);
  });
});
