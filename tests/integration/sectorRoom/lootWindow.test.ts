/**
 * Cargo pods, plan cargo-pods slices 11 + 14: a pod is looted through the
 * loot window (`cargo_query` / `cargo_move` on its entity id), never by flying
 * over it. Owner 2026-11-17: "cargo pods are open a window and drag or click
 * to loot"; open range is about a ship length; a pod only gives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';

function serverRoom(id: string): SectorRoom {
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

function ask(cr: Room, replies: CargoState[], type: 'cargo_query' | 'cargo_move', body: object): Promise<CargoState> {
  const n = replies.length;
  cr.send(type, { type, ...body });
  return until(() => replies.length > n, 4000).then((ok) => {
    if (!ok) throw new Error(`no cargo_state reply to ${type}`);
    return replies[replies.length - 1]!;
  });
}

describe('SectorRoom integration: the cargo pod loot window', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function setup(): Promise<{ cr: Room; r: SectorRoom; shipId: string; replies: CargoState[] }> {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const r = serverRoom(cr.roomId);
    let shipId = '';
    for (const [, s] of (r.state as SectorState).ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    return { cr, r, shipId, replies };
  }

  it('a pod beside the ship opens, a take moves one stack aboard, a put is refused', { timeout: 30_000 }, async () => {
    const { cr, r, shipId, replies } = await setup();
    const podId = r._internals.loot.drop({ goods: { salvage: 5, alloy: 3 }, blueprints: [] }, 20, 0, 0, 0, { alone: true })!;
    const entityId = r._internals.swarmRegistry.get(podId)!.entityId;

    // Sitting on it for a while never loads it (no fly-over pickup).
    await harness.advance(500);
    expect(getHoldStore().get(shipId)?.hold.goods.salvage ?? 0, 'flying over a pod loads nothing').toBe(0);

    const view = await ask(cr, replies, 'cargo_query', { entityId });
    expect(view.open).toBe(true);
    expect(view.hold?.goods).toEqual({ salvage: 5, alloy: 3 });

    const took = await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { alloy: 3 } } });
    expect(took.open).toBe(true);
    expect(took.hold?.goods.alloy ?? 0).toBe(0);
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(3);
    expect(getHoldStore().get(podId)?.hold.goods.salvage, 'the rest stays in the pod').toBe(5);

    const put = await ask(cr, replies, 'cargo_move', { entityId, dir: 'put', items: { goods: { alloy: 1 } } });
    expect(put.message).toBe('A cargo pod only gives.');
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(3);

    // Taking the last stack empties the pod: it leaves the world.
    await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { salvage: 5 } } });
    expect(getHoldStore().get(shipId)?.hold.goods.salvage).toBe(5);
    expect(r._internals.loot.isPod(podId), 'an emptied pod is gone').toBe(false);
  });

  it('a pod further than the open reach stays shut', { timeout: 30_000 }, async () => {
    const { cr, r, shipId, replies } = await setup();
    const podId = r._internals.loot.drop({ goods: { salvage: 5 }, blueprints: [] }, 1500, 0, 0, 0, { alone: true })!;
    const entityId = r._internals.swarmRegistry.get(podId)!.entityId;

    const view = await ask(cr, replies, 'cargo_query', { entityId });
    expect(view.open).toBe(false);
    const grab = await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { salvage: 5 } } });
    expect(grab.open).toBe(false);
    expect(getHoldStore().get(shipId)?.hold.goods.salvage ?? 0).toBe(0);
    expect(getHoldStore().get(podId)?.hold.goods.salvage).toBe(5);
  });
});
