/**
 * C3 (plan soft-leaping-truffle v3) — ship cargo over the real messages, with
 * the `breakInMs` bespoke trigger.
 *
 *  1. Another player's ship is locked; a break-in (a hostile act) alarms its
 *     owner; on success the thief takes from that ship's hold — both holds
 *     change in one move.
 *  2. An NPC ship's loot IS its hold (its loot table, rolled once): what a
 *     break-in takes is gone, so its death drops only what's left (never a
 *     second roll). Take it all, kill it: no loot pod appears.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { BreakInNotice, CargoState } from '../../../src/shared-types/messages/cargoMessages.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

function ask(cr: Room, replies: CargoState[], type: 'cargo_query' | 'cargo_move', body: object): Promise<CargoState> {
  const n = replies.length;
  cr.send(type, { type, ...body });
  return until(() => replies.length > n, 4000).then(() => replies[replies.length - 1]!);
}

function shipIdOf(state: SectorState, pid: string): string {
  for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
  return '';
}

describe('SectorRoom integration — ship cargo (C3)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it("breaking into another player's ship alarms them and lets the thief take from its hold", { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], breakInMs: 500 });
    const victim = randomUUID();
    const crV = await harness.connectActive(victim, { spawnX: 0, spawnY: 0, initialCargo: { goods: { alloy: 6 }, blueprints: [] } });
    const alarms: BreakInNotice[] = [];
    crV.onMessage('break_in_notice', (m: BreakInNotice) => alarms.push(m));
    const thief = randomUUID();
    const cr = await harness.connectActive(thief, { spawnX: 0, spawnY: 250 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const notices: BreakInNotice[] = [];
    cr.onMessage('break_in_notice', (m: BreakInNotice) => notices.push(m));
    const state = harness.getServerRoom()!.state as SectorState;
    const victimShip = shipIdOf(state, victim);
    const thiefShip = shipIdOf(state, thief);

    const locked = await ask(cr, replies, 'cargo_query', { ship: victim });
    expect(locked.open).toBe(false);
    expect(locked.targetShip).toBe(victim);
    expect(locked.breakIn).toEqual({ pct: null, durationMs: 500 });

    cr.send('break_in', { type: 'break_in', ship: victim });
    expect(await until(() => alarms.length > 0, 3_000), 'the victim is alarmed').toBe(true);
    expect(await until(() => notices.some((n) => n.tone === 'good'), 5_000), 'the break-in succeeds: ' + JSON.stringify(notices)).toBe(true);

    const open = await ask(cr, replies, 'cargo_query', { ship: victim });
    expect(open.open, open.message).toBe(true);
    expect(open.hold?.goods.alloy).toBe(6);
    const took = await ask(cr, replies, 'cargo_move', { ship: victim, dir: 'take', items: { goods: { alloy: 4 } } });
    expect(took.ok, took.message).toBe(true);
    expect(getHoldStore().get(victimShip)?.hold.goods.alloy).toBe(2);
    expect(getHoldStore().get(thiefShip)?.hold.goods.alloy).toBe(4);
  });

  it('an NPC ship drops only what is left in its hold — what a break-in took never drops again', { timeout: 40_000 }, async () => {
    // Peaceful drones: the break-in turns its side hostile, and a shot at the
    // thief would (correctly) interrupt it — this test is about the hold.
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], breakInMs: 400, peacefulDrones: true });
    const thief = randomUUID();
    const cr = await harness.connectActive(thief, { spawnX: 0, spawnY: 0, initialHull: 5000 });
    const replies: CargoState[] = [];
    cr.onMessage('cargo_state', (m: CargoState) => replies.push(m));
    const notices: BreakInNotice[] = [];
    cr.onMessage('break_in_notice', (m: BreakInNotice) => notices.push(m));
    const room = harness.getServerRoom()!;
    const internal = room._internals;
    internal.spawnTestDrone('mob-1', 0, 200);
    await harness.advance(100);
    const rec = internal.swarmRegistry.get('mob-1')!;
    // Something it was already carrying; its loot table rolls on top, once.
    getHoldStore().put({ holderUid: 'mob-1', holderType: 'hauler', ownerId: null, sectorKey: 'sol-prime', x: null, y: null, hold: { goods: { alloy: 5 }, blueprints: [] }, expiresAt: null }, false);

    const locked = await ask(cr, replies, 'cargo_query', { entityId: rec.entityId });
    expect(locked.open).toBe(false);
    cr.send('break_in', { type: 'break_in', entityId: rec.entityId });
    expect(await until(() => notices.some((n) => n.tone === 'good'), 5_000), 'the break-in succeeds: ' + JSON.stringify(notices)).toBe(true);
    const open = await ask(cr, replies, 'cargo_query', { entityId: rec.entityId });
    expect(open.open, open.message).toBe(true);
    const h = open.hold!;
    expect(h.goods.alloy ?? 0, 'the carried alloy is there').toBeGreaterThanOrEqual(5);
    // Asking twice never rolls twice.
    const again = await ask(cr, replies, 'cargo_query', { entityId: rec.entityId });
    expect(again.hold).toEqual(h);
    const items = {
      goods: h.goods,
      ...(h.blueprints.length > 0 ? { blueprints: h.blueprints.map((b) => b.uid) } : {}),
      ...(h.packed !== undefined && h.packed.length > 0 ? { packed: h.packed.map((p) => p.product) } : {}),
    };
    const took = await ask(cr, replies, 'cargo_move', { entityId: rec.entityId, dir: 'take', items });
    expect(took.ok, took.message).toBe(true);
    expect(getHoldStore().get(shipIdOf(room.state as SectorState, thief))?.hold.goods.alloy).toBe(h.goods.alloy);

    const podsBefore = getHoldStore().inSector('sol-prime', 'pod').length;
    internal.applyDamage('mob-1', thief, 1_000_000, 0, 200);
    await harness.advance(50);
    internal.applyDamage('mob-1', thief, 1_000_000, 0, 200);
    await harness.advance(300);
    expect(internal.swarmRegistry.get('mob-1') ?? null, 'the NPC is dead').toBeNull();
    expect(getHoldStore().inSector('sol-prime', 'pod').length, 'nothing left to drop: no pod').toBe(podsBefore);
  });
});
