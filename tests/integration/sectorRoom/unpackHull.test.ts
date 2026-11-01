/**
 * Economy v2 W5a (plan peppy-jumping-pinwheel) — UNPACKING a packed hull into
 * the roster, through a real SectorRoom and the real `unpack_hull` message.
 *
 *  1. the owner's storage inspector lists the packed hull (owner-only ids);
 *  2. unpacking takes the crate out of storage and adds a parked roster ship
 *     of that kind beside the storage;
 *  3. refusals: no such crate, someone else's storage, a full roster (the
 *     crate stays put).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { ROSTER_CAP } from '../../../src/server/playerShips/PlayerShipStore.js';
import type { BlueprintResult } from '../../../src/shared-types/blueprints.js';

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

describe('SectorRoom integration — unpacking hulls (economy v2 W5a)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('unpacks a crate into a parked roster ship; refuses the wrong cases', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 900, shipKind: 'fighter' });
    const internal = room(cr.roomId)._internals;
    const results: BlueprintResult[] = [];
    cr.onMessage('blueprint_result', (m: BlueprintResult) => results.push(m));
    const unpack = async (networkEntityId: number, kind: string): Promise<BlueprintResult> => {
      const n = results.length;
      // The REAL client payload: tradeClient's send() always adds `type`.
      cr.send('unpack_hull', { type: 'unpack_hull', networkEntityId, kind });
      expect(await until(() => results.length > n, 4000)).toBe(true);
      return results[results.length - 1]!;
    };

    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    const capEid = internal.swarmRegistry.get(cap.id)!.entityId;
    cap.hold = { goods: {}, blueprints: [], packed: [{ product: 'hull:gunship', quality: 50 }, { product: 'structure:smelter', quality: 30 }] };

    const before = getPlayerShipStore().listByPlayer(pid).length;
    // No interceptor crate here.
    expect((await unpack(capEid, 'interceptor')).ok).toBe(false);
    // The gunship crate unpacks into a parked roster ship beside the Capital.
    const ok = await unpack(capEid, 'gunship');
    expect(ok.ok, ok.message).toBe(true);
    expect(ok.message).toContain('Gunship');
    const roster = getPlayerShipStore().listByPlayer(pid);
    expect(roster).toHaveLength(before + 1);
    const ship = roster.find((r) => r.kind === 'gunship')!;
    expect(ship.isActive).toBe(false);
    expect(ship.lastSectorKey).toBe('sol-prime');
    expect(Math.hypot(ship.lastX - cap.x, ship.lastY - cap.y)).toBeLessThan(600);
    expect(cap.hold.packed).toEqual([{ product: 'structure:smelter', quality: 30 }]);

    // A full roster refuses and leaves the crate where it is.
    cap.hold.packed!.push({ product: 'hull:gunship', quality: 60 });
    while (getPlayerShipStore().listByPlayer(pid).length < ROSTER_CAP) {
      getPlayerShipStore().create({ playerId: pid, userId: null, kind: 'scout', sectorKey: 'sol-prime', x: 0, y: 0, health: 100 });
    }
    const full = await unpack(capEid, 'gunship');
    expect(full.ok).toBe(false);
    expect(full.message).toMatch(/roster is full/);
    expect(cap.hold.packed!.some((p) => p.product === 'hull:gunship')).toBe(true);
  });

  it('someone else’s storage is refused', { timeout: 30_000 }, async () => {
    const owner = randomUUID();
    const thief = randomUUID();
    const a = await harness.connectActive(owner, { spawnX: 0, spawnY: 900, shipKind: 'fighter' });
    const internal = room(a.roomId)._internals;
    a.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 0 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === owner), 5000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === owner)!;
    cap.hold = { goods: {}, blueprints: [], packed: [{ product: 'hull:gunship', quality: 50 }] };
    const b = await harness.connectActive(thief, { spawnX: 600, spawnY: 900, shipKind: 'fighter' });
    const results: BlueprintResult[] = [];
    b.onMessage('blueprint_result', (m: BlueprintResult) => results.push(m));
    b.send('unpack_hull', { type: 'unpack_hull', networkEntityId: internal.swarmRegistry.get(cap.id)!.entityId, kind: 'gunship' });
    expect(await until(() => results.length > 0, 4000)).toBe(true);
    expect(results[0]!.ok).toBe(false);
    expect(cap.hold.packed).toHaveLength(1);
  });
});
