/**
 * Live bug 2026-11-21: a fresh pilot placed their starter Capital in Build
 * mode, and 10+ minutes later the HUD still read "▢1" (one packed crate,
 * 25 weight) while the build menu (from `packed_stock`) said "Capital · needs
 * packed". The server hold WAS right: the crate had been taken.
 *
 * Cause: Build / Command lets go of the ship (the hull is parked, not ACTIVE),
 * and the own-ship cargo slice was sent for the own ACTIVE hull only. While
 * parked the hold the player builds from (`PilotSwap.ownShipKey`) never
 * reached the wire, so the client's cargo froze at its last piloted value
 * (#16: client-visible state must be reconstructible from the snapshot).
 *
 * Fix: the slice (and `fitted`, the capacity it is read against) rides the
 * recipient's own ship as `ownShipKey` names it: the flown hull, else the
 * hull parked by Command / Build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, withCapitalCrates, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages/snapshotMessages.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';

function room(id: string): SectorRoom {
  return matchMaker.getLocalRoomById(id) as unknown as SectorRoom;
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('SectorRoom integration — own cargo slice on the hull parked by Build / Command', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('placing the Capital from a parked hull drops the crate from the own cargo slice', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0, initialCargo: withCapitalCrates(1, { goods: { salvage: 3 }, blueprints: [] }) });
    const r = room(cr.roomId);
    const state = r.state as SectorState;
    let shipId = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');

    // Build / Command: let go of the ship (it parks in place).
    cr.send('command', { type: 'command' });
    expect(await until(() => state.ships.get(shipId)?.isActive === false, 5_000), 'the hull parks').toBe(true);

    // Place the Capital from the parked hull's crate.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: -600 });
    expect(await until(() => [...r._internals.structureRegistry.all()].some((s) => s.owner === pid), 5_000), 'the Capital is placed').toBe(true);
    expect(getHoldStore().get(shipId)?.hold.packed ?? [], 'the server hold lost the crate').toEqual([]);

    // The own-ship slice must show the hold as it is now: salvage, no crate.
    let last: SnapshotMessage['states'][string]['cargo'];
    let ok = false;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && !ok) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      last = snap.states?.[shipId]?.cargo;
      ok = last !== undefined && (last.goods['salvage'] ?? 0) === 3 && (last.packed?.length ?? 0) === 0;
    }
    expect(ok, `own parked hull cargo slice: ${JSON.stringify(last)}`).toBe(true);
  });
});
