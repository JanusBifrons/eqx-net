/**
 * C1 (plan soft-leaping-truffle v3) — open a structure's cargo and move items
 * by hand, over the real `cargo_query` / `cargo_move` messages.
 *
 *  1. Your own Capital opens; take some alloy aboard, put some back. Each move
 *     replies with a fresh `cargo_state`, and the ship's hold row changes.
 *  2. A withdrawal sticks: auto-deposit does not bank it straight back while
 *     you stay near your storage.
 *  3. Locked for anyone it doesn't open for: another pilot, an NPC base.
 *  4. Out of range: "Fly closer".
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

/** Send a request and wait for the next `cargo_state` reply. */
function ask(cr: Room, replies: CargoState[], type: 'cargo_query' | 'cargo_move', body: object): Promise<CargoState> {
  const n = replies.length;
  cr.send(type, { type, ...body });
  return until(() => replies.length > n, 4000).then((ok) => {
    if (!ok) throw new Error(`no cargo_state reply to ${type}`);
    return replies[replies.length - 1]!;
  });
}

describe('SectorRoom integration — cargo access (C1)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('opens your own storage; take and put move items; a withdrawal is not auto-deposited back', { timeout: 40_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 0, spawnY: 0 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const r = serverRoom(cr.roomId);
    const internal = r._internals;
    let shipId = '';
    for (const [, s] of (r.state as SectorState).ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;

    // 350 u centre to centre: inside auto-deposit range (400), so a withdrawal
    // would be banked straight back without the manual-cargo rule.
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 350 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === pid), 5_000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === pid)!;
    cap.hold = { goods: { alloy: 10 }, blueprints: [] };
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;

    const view = await ask(cr, replies, 'cargo_query', { entityId });
    expect(view.open, view.message).toBe(true);
    expect(view.hold?.goods.alloy).toBe(10);

    const took = await ask(cr, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { alloy: 4 } } });
    expect(took.ok, took.message).toBe(true);
    expect(took.hold?.goods.alloy).toBe(6);
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(4);

    const put = await ask(cr, replies, 'cargo_move', { entityId, dir: 'put', items: { goods: { alloy: 1 } } });
    expect(put.ok, put.message).toBe(true);
    expect(cap.hold?.goods.alloy).toBe(7);
    expect(getHoldStore().get(shipId)?.hold.goods.alloy).toBe(3);

    // The 2 s auto-deposit dwell would have banked it by now; it must not.
    await new Promise((res) => setTimeout(res, 3000));
    expect(getHoldStore().get(shipId)?.hold.goods.alloy, 'a withdrawal must stick').toBe(3);
  });

  it('is locked for another pilot and for an NPC base, and asks you to fly closer when far', { timeout: 40_000 }, async () => {
    const owner = randomUUID();
    const visitor = randomUUID();
    const crOwner = await harness.connectActive(owner, { spawnX: 0, spawnY: 0 });
    const crVisitor = await harness.connectActive(visitor, { spawnX: 0, spawnY: 150 });
    const replies: CargoState[] = [];
    crVisitor.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const ownerReplies: CargoState[] = [];
    crOwner.onMessage('cargo_state', (m: CargoState) => ownerReplies.push(m));
    const internal = serverRoom(crOwner.roomId)._internals;

    crOwner.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 450 });
    expect(await until(() => [...internal.structureRegistry.all()].some((s) => s.owner === owner), 5_000)).toBe(true);
    const cap = [...internal.structureRegistry.all()].find((s) => s.owner === owner)!;
    cap.hold = { goods: { alloy: 10 }, blueprints: [] };
    const entityId = internal.swarmRegistry.get(cap.id)!.entityId;

    const stranger = await ask(crVisitor, replies, 'cargo_query', { entityId });
    expect(stranger.open).toBe(false);
    expect(stranger.hold).toBeNull();
    expect(stranger.message).toMatch(/Locked/);
    const grab = await ask(crVisitor, replies, 'cargo_move', { entityId, dir: 'take', items: { goods: { alloy: 10 } } });
    expect(grab.ok).toBe(false);
    expect(cap.hold?.goods.alloy, 'a stranger takes nothing').toBe(10);

    // An NPC trader base is neutral: locked too (a break-in is C2).
    cap.owner = 'npc:traders:test';
    const npc = await ask(crOwner, ownerReplies, 'cargo_query', { entityId });
    expect(npc.open).toBe(false);
    expect(npc.message).toMatch(/Locked/);
    cap.owner = owner;

    // Too far from the footprint.
    internal.postToWorker({ type: 'SET_POSITION', entityId: owner, x: 0, y: -3000, angle: 0, vx: 0, vy: 0, angvel: 0 });
    const far = await (async () => {
      for (let i = 0; i < 20; i++) {
        const st = await ask(crOwner, ownerReplies, 'cargo_query', { entityId });
        if (!st.open) return st;
        await new Promise((res) => setTimeout(res, 100));
      }
      return ownerReplies[ownerReplies.length - 1]!;
    })();
    expect(far.open).toBe(false);
    expect(far.message).toMatch(/Fly closer/);
  });
});
