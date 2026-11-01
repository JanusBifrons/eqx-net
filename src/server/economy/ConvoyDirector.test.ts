/**
 * T2 — ConvoyDirector decision logic over hand-rolled fake rooms (the
 * TransitOrchestrator pattern). A fake bot "flies" by teleporting to its move
 * target; trade transfers move goods between a fake base stock and the real
 * HoldStore, so conservation is checked on real hold rows.
 */
import { describe, expect, it } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { cloneHold } from '../../core/cargo/hold.js';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import type { GoodId, Hold } from '../../shared-types/goods.js';
import { HoldStore } from '../cargo/HoldStore.js';
import type { TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import { ConvoyDirector, DEFAULT_CONVOY_OPTIONS, dockPoint, edgeNear, type ConvoyRoom, type NpcBaseTrade } from './ConvoyDirector.js';

const SINK: IPersistenceSink = {
  enqueueCritical: () => {}, enqueueVolatile: () => {},
  enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
};

interface FakeBase { owner: string; uid: string; stock: Partial<Record<GoodId, number>>; uses: Partial<Record<GoodId, number>>; box: NpcBaseTrade['box'] }

class FakeRoom implements ConvoyRoom {
  readonly bus = new Bus();
  readonly poses = new Map<string, { x: number; y: number; angle: number }>();
  readonly dropped: Hold[] = [];
  constructor(readonly bases: FakeBase[], readonly holds: HoldStore) {}
  eventBus(): Bus { return this.bus; }
  hasFreeSlot(): boolean { return true; }
  spawnLivingWorldBot(s: { botId: string; x: number; y: number }): boolean { this.poses.set(s.botId, { x: s.x, y: s.y, angle: 0 }); return true; }
  despawnLivingWorldBot(id: string): unknown { this.poses.delete(id); return null; }
  getBotPose(id: string) { return this.poses.get(id) ?? null; }
  setBotMoveTarget(id: string, x: number, y: number): void { const p = this.poses.get(id); if (p) { p.x = x; p.y = y; } }
  tradeDropAt(h: Hold): void { this.dropped.push(h); }
  clearPointNear(x: number, y: number) { return { x, y }; }
  npcBaseTrade(): NpcBaseTrade[] {
    return this.bases.map((b) => ({ owner: b.owner, networkUid: b.uid, box: b.box, view: { stock: { ...b.stock }, freeCapacity: 100_000, uses: b.uses, makes: {} } }));
  }
  tradeTransfer(owner: string, uid: string, spec: TradeTransferSpec): TradeTransferResult | null {
    const b = this.bases.find((x) => x.owner === owner && x.uid === uid);
    if (!b) return null;
    const taken: Hold = { goods: {}, blueprints: [] };
    if (spec.take) {
      for (const [g, n] of Object.entries(spec.take.want.goods)) {
        const t = Math.min(b.stock[g as GoodId] ?? 0, n ?? 0);
        b.stock[g as GoodId] = (b.stock[g as GoodId] ?? 0) - t;
        if (t > 0) taken.goods[g as GoodId] = t;
      }
      this.holds.put({ holderUid: spec.take.intoUid, holderType: 'hauler', ownerId: null, sectorKey: 's', x: null, y: null, hold: cloneHold(taken), expiresAt: null }, false);
    }
    for (const h of spec.release ?? []) {
      const rec = this.holds.get(h);
      if (rec) for (const [g, n] of Object.entries(rec.hold.goods)) b.stock[g as GoodId] = (b.stock[g as GoodId] ?? 0) + (n ?? 0);
      this.holds.delete(h, false);
    }
    return { taken, overflow: { goods: {}, blueprints: [] }, x: 0, y: 0 };
  }
}

const BOX_A = { x0: 2000, x1: 3000, y0: 2000, y1: 3000 };
const BOX_B = { x0: -3000, x1: -2000, y0: -3000, y1: -2000 };

function setup(sameSector: boolean, clock: { t: number }) {
  const holds = new HoldStore({ persistence: () => SINK });
  const exporter: FakeBase = { owner: 'npc:traders:ex', uid: 'u-ex', stock: { alloy: 1000 }, uses: {}, box: BOX_A };
  const importer: FakeBase = { owner: 'npc:traders:im', uid: 'u-im', stock: {}, uses: { alloy: 20 }, box: BOX_B };
  const rooms = new Map<string, ConvoyRoom>();
  let ra: FakeRoom, rb: FakeRoom;
  if (sameSector) {
    ra = rb = new FakeRoom([exporter, importer], holds);
    rooms.set('sol-prime', ra);
  } else {
    ra = new FakeRoom([exporter], holds);
    rb = new FakeRoom([importer], holds);
    rooms.set('sol-prime', ra);
    rooms.set('vega-reach', rb);
  }
  const dir = new ConvoyDirector(rooms, holds, { ...DEFAULT_CONVOY_OPTIONS, planIntervalMs: 1000, hopMs: 20_000 }, () => clock.t);
  return { holds, exporter, importer, ra, rb, dir };
}

describe('ConvoyDirector (T2)', () => {
  it('same sector: load at the exporter, unload at the importer, leave — goods conserved, no hold left', () => {
    const clock = { t: 0 };
    const { holds, exporter, importer, dir } = setup(true, clock);
    dir.tick(); // plan + launch
    expect(dir.active()).toHaveLength(1);
    expect(dir.active()[0]!.phase).toBe('pickup');
    for (let i = 0; i < 8 && dir.active().length > 0; i++) { clock.t += 1000; dir.tick(); }
    expect(dir.active()).toHaveLength(0);
    const moved = importer.stock.alloy ?? 0;
    expect(moved).toBeGreaterThan(0);
    expect((exporter.stock.alloy ?? 0) + moved).toBe(1000);
    expect(holds.ofType('hauler')).toHaveLength(0);
  });

  it('across sectors: in transit for hops × hopMs, then delivers in the importer room', () => {
    const clock = { t: 0 };
    const { importer, ra, rb, dir } = setup(false, clock);
    const stepUntil = (phase: string): void => {
      for (let i = 0; i < 10 && dir.active()[0]?.phase !== phase; i++) { clock.t += 1000; dir.tick(); }
      expect(dir.active()[0]?.phase).toBe(phase);
    };
    dir.tick();
    stepUntil('outbound'); // flew to the exporter's dock and loaded
    stepUntil('transit'); // flew to the edge and left
    expect(ra.poses.size, 'the hauler left the exporter sector').toBe(0);
    clock.t += 10_000; dir.tick();
    expect(dir.active()[0]!.phase, 'still travelling (sol-prime → vega-reach is ≥ 1 hop)').toBe('transit');
    for (let i = 0; i < 40 && dir.active().length > 0; i++) { clock.t += 5_000; dir.tick(); }
    expect(dir.active()).toHaveLength(0);
    expect(importer.stock.alloy ?? 0).toBeGreaterThan(0);
    expect(rb.poses.size).toBe(0);
  });

  it('a raided hauler ends its convoy (the room spills the hold)', () => {
    const clock = { t: 0 };
    const { ra, dir } = setup(true, clock);
    dir.start();
    try {
      dir.tick();
      const id = dir.active()[0]!.haulerId;
      ra.poses.delete(id);
      ra.bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: id } as never);
      expect(dir.active()).toHaveLength(0);
    } finally {
      dir.stop();
    }
  });

  it('start() discards convoy holds a crash left behind', () => {
    const clock = { t: 0 };
    const { holds, dir } = setup(true, clock);
    holds.put({ holderUid: 'hauler-convoy-old', holderType: 'hauler', ownerId: null, sectorKey: 's', x: null, y: null, hold: { goods: { alloy: 5 }, blueprints: [] }, expiresAt: null }, false);
    holds.put({ holderUid: 'hauler-deal-keep', holderType: 'hauler', ownerId: null, sectorKey: 's', x: null, y: null, hold: { goods: { alloy: 5 }, blueprints: [] }, expiresAt: null }, false);
    dir.start();
    dir.stop();
    expect(holds.get('hauler-convoy-old')).toBeUndefined();
    expect(holds.get('hauler-deal-keep')).toBeDefined();
  });

  it('docks outside the footprint; enters on the base side, never inside it', () => {
    const d = dockPoint(BOX_A, 250, 0, 0);
    expect(d.x).toBeLessThanOrEqual(BOX_A.x0 - 250);
    expect(d.y).toBeLessThanOrEqual(BOX_A.y0 - 250);
    // BOX_A sits toward +x +y: enter on that side, outside the box.
    const e = edgeNear(BOX_A, 4500, 550);
    expect(e.x).toBeGreaterThan(0);
    expect(e.y).toBeGreaterThan(0);
    const inside = e.x > BOX_A.x0 - 550 && e.x < BOX_A.x1 + 550 && e.y > BOX_A.y0 - 550 && e.y < BOX_A.y1 + 550;
    expect(inside).toBe(false);
    // A base reaching the edge along the ray: step back toward the centre.
    const big = { x0: 1000, x1: 4900, y0: 1000, y1: 4900 };
    const e2 = edgeNear(big, 4500, 550);
    expect(e2.x < big.x0 - 550 || e2.y < big.y0 - 550).toBe(true);
  });

  it('does not promise the same exporter goods twice while a convoy is still on its way', () => {
    const clock = { t: 0 };
    const holds = new HoldStore({ persistence: () => SINK });
    const exporter: FakeBase = { owner: 'npc:traders:ex', uid: 'u-ex', stock: { alloy: 205 }, uses: {}, box: BOX_A };
    const i1: FakeBase = { owner: 'npc:traders:i1', uid: 'u-1', stock: {}, uses: { alloy: 20 }, box: BOX_B };
    const room = new FakeRoom([exporter, i1], holds);
    // Never let the hauler reach the dock: it stays in pickup.
    room.setBotMoveTarget = () => {};
    const dir = new ConvoyDirector(new Map([['sol-prime', room]]), holds, { ...DEFAULT_CONVOY_OPTIONS, planIntervalMs: 1000 }, () => clock.t);
    dir.tick();
    expect(dir.active()).toHaveLength(1);
    i1.uses = { alloy: 20 }; // still needs it — but it's in flight
    const i2: FakeBase = { owner: 'npc:traders:i2', uid: 'u-2', stock: {}, uses: { alloy: 20 }, box: BOX_B };
    room.bases.push(i2);
    clock.t += 1000; dir.tick();
    // 205 alloy: the first convoy promised 200 (a hauler-load); the 5 left
    // (weight 10) are below a worthwhile load — no second convoy. Without the
    // promise, the exporter would still look like it had 205 to give.
    expect(dir.active()).toHaveLength(1);
  });
});
