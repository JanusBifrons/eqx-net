import { describe, expect, it } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { HoldStore } from '../cargo/HoldStore.js';
import type { TradeNetworkSnapshot, TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import { cloneHold, emptyHold, transferInto } from '../../core/cargo/hold.js';
import type { Hold } from '../../shared-types/goods.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { EconomyStore } from './EconomyStore.js';
import { TradeDirector, type TradeRoom } from './TradeDirector.js';
import { REP_DEAL_COMPLETED, REP_PIRACY_HIT, REP_SELF_RAID, type TradeNotice } from '../../shared-types/economy.js';
import { buyCost, sellProceeds } from '../../core/economy/deals.js';

const OWNER = 'p1';
const NET_UID = 'st-1';

function sink(): IPersistenceSink & { ops: PersistOp[] } {
  const ops: PersistOp[] = [];
  return {
    ops,
    enqueueCritical: (op: PersistOp) => { ops.push(op); },
    enqueueVolatile: () => {},
  } as unknown as IPersistenceSink & { ops: PersistOp[] };
}

/** A one-room fake: the base network is a single in-memory hold. */
class FakeRoom implements TradeRoom {
  readonly bus = new Bus();
  net: Hold = emptyHold();
  netExists = true;
  underAttack = false;
  poses = new Map<string, { x: number; y: number; angle: number }>();
  pods: Hold[] = [];
  notices: TradeNotice[] = [];
  constructor(private readonly holds: HoldStore) {}
  eventBus(): Bus { return this.bus; }
  hasFreeSlot(): boolean { return true; }
  spawnLivingWorldBot(spec: { botId: string; x: number; y: number }): boolean {
    this.poses.set(spec.botId, { x: spec.x, y: spec.y, angle: 0 });
    return true;
  }
  despawnLivingWorldBot(botId: string): null { this.poses.delete(botId); return null; }
  getBotPose(botId: string): { x: number; y: number; angle: number } | null { return this.poses.get(botId) ?? null; }
  setBotMoveTarget(): void {}
  tradeSnapshot(owner: string, uid: string): TradeNetworkSnapshot | null {
    if (!this.netExists || owner !== OWNER || uid !== NET_UID) return null;
    return { goods: { ...this.net.goods }, credits: this.net.credits, freeCapacity: 10_000, x: 0, y: 0 };
  }
  tradeTransfer(owner: string, uid: string, spec: TradeTransferSpec): TradeTransferResult | null {
    if (this.tradeSnapshot(owner, uid) === null) return null;
    const taken = emptyHold();
    const puts = [];
    const deletes: string[] = [];
    if (spec.take) {
      const w = spec.take.want;
      const c = Math.min(w.credits, this.net.credits);
      this.net.credits -= c;
      taken.credits = c;
      for (const [g, n] of Object.entries(w.goods) as Array<[keyof Hold['goods'], number]>) {
        const have = this.net.goods[g] ?? 0;
        const t = Math.min(have, n);
        if (have - t > 0) this.net.goods[g] = have - t; else delete this.net.goods[g];
        if (t > 0) taken.goods[g] = t;
      }
      const prev = this.holds.get(spec.take.intoUid)?.hold ?? emptyHold();
      const into = cloneHold(prev);
      transferInto(into, cloneHold(taken), Infinity);
      puts.push({ holderUid: spec.take.intoUid, holderType: 'hauler' as const, ownerId: owner, sectorKey: 's', x: null, y: null, hold: into, expiresAt: null });
    }
    for (const r of spec.release ?? []) {
      const h = this.holds.get(r)?.hold;
      if (h) transferInto(this.net, cloneHold(h), Infinity);
      deletes.push(r);
    }
    this.net.credits += spec.mintCredits ?? 0;
    for (const d of spec.destroy ?? []) deletes.push(d);
    this.holds.commit(puts, deletes, true, spec.extraOps ?? []);
    return { taken, overflow: emptyHold(), x: 0, y: 0 };
  }
  tradeBaseUnderAttack(): boolean { return this.underAttack; }
  tradeDropAt(hold: Hold): void { this.pods.push(cloneHold(hold)); }
  tradeNotify(playerId: string, n: TradeNotice): void { if (playerId === OWNER) this.notices.push(n); }
  /** Faithful kill: the real room spills the hauler's hold, then emits. */
  killHauler(haulerId: string): void {
    const rec = this.holds.get(haulerId);
    if (rec) { this.pods.push(cloneHold(rec.hold)); this.holds.delete(haulerId); }
    this.poses.delete(haulerId);
    this.bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: haulerId });
  }
}

function setup() {
  let now = 1_000_000;
  const s = sink();
  const holds = new HoldStore({ persistence: () => s, now: () => now });
  const store = new EconomyStore({ persistence: () => s, now: () => now });
  const room = new FakeRoom(holds);
  const dir = new TradeDirector(new Map([['s', room]]), store, holds, {
    rng: () => 0.5, nowMs: () => now, controlIntervalMs: 1_000_000, dockMs: 1000, departMs: 1000,
  });
  dir.start();
  const advance = (ms: number): void => { now += ms; dir.tick(); };
  /** Fly the current hauler to its dock (the fake has no physics). */
  const arrive = (): string => {
    const deal = [...store.allDeals()][0]!;
    const run = deal.run!;
    room.poses.set(run.haulerId, { x: run.dockX, y: run.dockY, angle: 0 });
    return run.haulerId;
  };
  return { dir, store, holds, room, advance, arrive, sink: s, stop: () => dir.stop() };
}

function acceptFirst(t: ReturnType<typeof setup>, kind: 'sell' | 'buy', good: 'salvage' | 'alloy', qty: number, recurrenceMin: 10 | null = null) {
  const offer = t.dir.offersFor(OWNER).find((o) => o.kind === kind && o.good === good)!;
  const v = t.dir.acceptOffer(OWNER, 's', NET_UID, {
    type: 'accept_offer', offerId: offer.offerId, networkEntityId: 1, qty,
    recurrenceMin, visits: recurrenceMin ? 3 : null, priceBandPct: 10,
  });
  expect(v.ok).toBe(true);
  return offer;
}

describe('TradeDirector', () => {
  it('SELL: goods go into the hauler at dock and credits arrive only on safe departure', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    const offer = acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1); // start visit → inbound
    expect([...t.store.allDeals()][0]!.state).toBe('inbound');
    const hauler = t.arrive();
    t.advance(1); // dock → escrow
    expect(t.room.net.goods.salvage).toBe(30);
    expect(t.holds.get(hauler)!.hold.goods.salvage).toBe(20);
    expect(t.room.net.credits).toBe(0); // nothing paid while docked
    t.advance(1000); // → departing
    t.advance(1000); // → settled
    expect(t.room.net.credits).toBe(sellProceeds(20, offer.unitPrice));
    expect(t.holds.get(hauler)).toBeUndefined();
    expect([...t.store.allDeals()][0]!.state).toBe('settled');
    expect(t.store.rep(OWNER, 'traders')).toBe(REP_DEAL_COMPLETED);
    expect(t.store.view(OWNER).history[0]!.outcome).toBe('settled');
    t.stop();
  });

  it('BUY: credits sit in escrow while docked; goods land on departure', () => {
    const t = setup();
    t.room.net.credits = 2000;
    const offer = acceptFirst(t, 'buy', 'alloy', 10);
    t.advance(1);
    t.arrive();
    t.advance(1);
    const cost = buyCost(10, offer.unitPrice);
    expect(t.room.net.credits).toBe(2000 - cost);
    expect(t.room.net.goods.alloy).toBeUndefined();
    t.advance(1000);
    t.advance(1000);
    expect(t.room.net.goods.alloy).toBe(10);
    expect(t.room.net.credits).toBe(2000 - cost);
    t.stop();
  });

  it('RAID while docked: the hauler’s goods spill, the buyer’s escrow is refunded, pirates lose standing', () => {
    const t = setup();
    t.room.net.credits = 2000;
    acceptFirst(t, 'buy', 'alloy', 10);
    t.advance(1);
    const hauler = t.arrive();
    t.advance(1);
    t.dir.onHaulerDamaged(hauler, 'pirate');
    t.room.killHauler(hauler);
    expect(t.room.net.credits).toBe(2000); // refunded in full
    expect(t.room.pods.some((p) => p.goods.alloy === 10)).toBe(true); // trader's goods spilled
    expect(t.store.rep('pirate', 'traders')).toBe(REP_PIRACY_HIT);
    expect([...t.store.allDeals()][0]!.state).toBe('failed');
    expect(t.room.notices.at(-1)!.event).toBe('raided');
    t.stop();
  });

  it('SELF-RAID: the owner shooting their own hauler forfeits the escrow', () => {
    const t = setup();
    t.room.net.credits = 2000;
    const offer = acceptFirst(t, 'buy', 'alloy', 10);
    t.advance(1);
    const hauler = t.arrive();
    t.advance(1);
    t.dir.onHaulerDamaged(hauler, OWNER);
    t.room.killHauler(hauler);
    expect(t.room.net.credits).toBe(2000 - buyCost(10, offer.unitPrice));
    expect(t.store.rep(OWNER, 'traders')).toBe(REP_SELF_RAID);
    t.stop();
  });

  it('SELL raided: the player’s goods are in the hauler and spill with it (no refund)', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1);
    const hauler = t.arrive();
    t.advance(1);
    t.room.killHauler(hauler);
    expect(t.room.net.goods.salvage).toBe(30);
    expect(t.room.pods.some((p) => p.goods.salvage === 20)).toBe(true);
    expect(t.room.net.credits).toBe(0);
    t.stop();
  });

  it('skips a visit while the base is under attack, without spawning a hauler', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    t.room.underAttack = true;
    acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1);
    const deal = [...t.store.allDeals()][0]!;
    expect(deal.state).toBe('scheduled');
    expect(deal.run).toBeNull();
    expect(t.room.poses.size).toBe(0);
    expect(t.store.view(OWNER).history[0]!.note).toContain('under attack');
    t.stop();
  });

  it('a recurring deal runs again after its interval', () => {
    const t = setup();
    t.room.net.goods.salvage = 100;
    acceptFirst(t, 'sell', 'salvage', 10, 10);
    for (let v = 0; v < 2; v++) {
      t.advance(1);
      t.arrive();
      t.advance(1);
      t.advance(1000);
      t.advance(1000);
      if (v === 0) {
        const d = [...t.store.allDeals()][0]!;
        expect(d.state).toBe('scheduled');
        expect(d.visitsLeft).toBe(2);
        t.advance(10 * 60_000);
      }
    }
    expect(t.room.net.goods.salvage).toBe(80);
    t.stop();
  });

  it('restart mid-visit: reconcile returns a docked sell’s goods to the base', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1);
    t.arrive();
    t.advance(1);
    expect(t.room.net.goods.salvage).toBe(30);
    // "Restart": a fresh director over the same stores (haulers are not persisted).
    t.stop();
    const dir2 = new TradeDirector(new Map([['s', t.room]]), t.store, t.holds, { controlIntervalMs: 1_000_000 });
    dir2.reconcile();
    expect(t.room.net.goods.salvage).toBe(50);
    const d = [...t.store.allDeals()][0]!;
    expect(d.run).toBeNull();
    expect(d.state).toBe('scheduled');
  });

  it('every escrow move persists the deal state in the SAME atomic group', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1);
    t.arrive();
    t.sink.ops.length = 0;
    t.advance(1); // dock
    const group = t.sink.ops.find((o) => o.type === 'GROUP') as Extract<PersistOp, { type: 'GROUP' }> | undefined;
    expect(group).toBeDefined();
    expect(group!.ops.some((o) => o.type === 'HOLD_PUT')).toBe(true);
    expect(group!.ops.some((o) => o.type === 'TRADE_DEAL_PUT')).toBe(true);
    t.stop();
  });

  it('refuses a deal when the player has no storage, or the network is at its deal cap', () => {
    const t = setup();
    const offer = t.dir.offersFor(OWNER).find((o) => o.kind === 'sell')!;
    const base = { type: 'accept_offer' as const, offerId: offer.offerId, networkEntityId: 1, qty: 1, recurrenceMin: null, visits: null, priceBandPct: 0 };
    expect(t.dir.acceptOffer(OWNER, 's', 'nope', base).ok).toBe(false);
    for (let i = 0; i < 3; i++) expect(t.dir.acceptOffer(OWNER, 's', NET_UID, base).ok).toBe(true);
    expect(t.dir.acceptOffer(OWNER, 's', NET_UID, base).message).toContain('at most 3');
    t.stop();
  });

  it('escort prompt: an NPC hitting the owner’s hauler sends one throttled under-fire notice', () => {
    const t = setup();
    t.room.net.goods.salvage = 50;
    acceptFirst(t, 'sell', 'salvage', 20);
    t.advance(1);
    const hauler = t.arrive();
    t.dir.onHaulerDamaged(hauler, null);
    t.dir.onHaulerDamaged(hauler, null);
    expect(t.room.notices.filter((n) => n.event === 'under_fire')).toHaveLength(1);
    // An NPC raid records no pirate (no standing lost by anyone).
    expect([...t.store.allDeals()][0]!.run!.attackers).toEqual([]);
    t.stop();
  });
});
