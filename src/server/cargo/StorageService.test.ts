import { describe, expect, it } from 'vitest';
import { StorageService, structureUid, DEPOSIT_RANGE, SALVAGE_TO_MINERALS } from './StorageService.js';
import { HoldStore } from './HoldStore.js';
import { StructureRegistry, type StructureRecord } from '../structures/StructureRegistry.js';
import { structureKindToIndex, type StructureKindId } from '../../shared-types/structureKinds.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

function rec(id: string, kind: StructureKindId, x: number, y: number, over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'p1', kind, subtypeIndex: structureKindToIndex(kind), x, y, radius: 20,
    isConstructed: true, constructionProgress: 0, constructionCost: 0, isDeconstructing: false,
    minerals: 0, storedPower: 0, level: 1, uid: structureUid('s', 'p1', kind, x, y), ...over,
  };
}

function setup(component: string[] = []) {
  const ops: PersistOp[] = [];
  const sink: IPersistenceSink = {
    enqueueCritical: (op) => { ops.push(op); }, enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
  };
  const holdStore = new HoldStore({ persistence: () => sink });
  const registry = new StructureRegistry();
  const svc = new StorageService({
    holdStore, registry, sectorKey: () => 's',
    componentOf: (id) => (component.includes(id) ? component : [id]),
  });
  const ship = (goods: Record<string, number>) =>
    holdStore.put({ holderUid: 'ship-1', holderType: 'ship', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: { goods, blueprints: [] }, expiresAt: null });
  return { svc, holdStore, registry, ops, ship };
}

describe('StorageService (P1a-2)', () => {
  it('uid is deterministic from persisted fields (survives a restore)', () => {
    expect(structureUid('s', 'p', 'capital', 10.2, 20.4)).toBe(structureUid('s', 'p', 'capital', 10.4, 19.6));
    expect(structureUid('s', 'p', 'capital', 10, 20)).not.toBe(structureUid('t', 'p', 'capital', 10, 20));
  });

  it('deposit: minerals fund the Capital bank, goods fill the hold, ship emptied — ONE atomic group', () => {
    const t = setup();
    const cap = rec('c', 'capital', 0, 0);
    t.registry.add(cap);
    t.ship({ minerals: 50, salvage: 7 });
    t.ops.length = 0;
    const moved = t.svc.deposit('ship-1', 'p1', cap);
    expect(moved.goods.salvage).toBe(7);
    expect(cap.minerals).toBe(50);
    expect(cap.hold!.goods.salvage).toBe(7);
    expect(t.holdStore.get('ship-1')).toBeUndefined();
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
  });

  it('overflows across the connected storage network; leftovers stay aboard', () => {
    const bay = rec('b', 'cargo_bay', 100, 0);
    const bay2 = rec('b2', 'cargo_bay', 200, 0);
    const t = setup(['b', 'b2']);
    t.registry.add(bay);
    t.registry.add(bay2);
    t.ship({ core: 1000 }); // 5000 weight, bays hold 2000 each
    t.svc.deposit('ship-1', 'p1', bay);
    expect(bay.hold!.goods.core).toBe(400);
    expect(bay2.hold!.goods.core).toBe(400);
    expect(t.holdStore.get('ship-1')!.hold.goods.core).toBe(200);
  });

  it('a blueprint (unbuilt) or foreign storage is not a deposit target', () => {
    const t = setup();
    t.registry.add(rec('x', 'cargo_bay', 10, 0, { isConstructed: false }));
    t.registry.add(rec('y', 'cargo_bay', 20, 0, { owner: 'other' }));
    expect(t.svc.nearestOwnStorage('p1', 0, 0)).toBeNull();
    t.registry.add(rec('z', 'cargo_bay', DEPOSIT_RANGE + 50, 0));
    expect(t.svc.nearestOwnStorage('p1', 0, 0)).toBeNull();
  });

  it('refine turns network salvage into Capital minerals', () => {
    const cap = rec('c', 'capital', 0, 0);
    const bay = rec('b', 'cargo_bay', 100, 0, { hold: { goods: { salvage: 5 }, blueprints: [] } });
    const t = setup(['c', 'b']);
    t.registry.add(cap);
    t.registry.add(bay);
    expect(t.svc.refine(cap, 3)).toBe(3);
    expect(cap.minerals).toBe(3 * SALVAGE_TO_MINERALS);
    expect(bay.hold!.goods.salvage).toBe(2);
  });

  it('restore overlays the holds row (bank → minerals, rest → hold)', () => {
    const t = setup();
    const cap = rec('c', 'capital', 0, 0);
    t.holdStore.hydrate([{ holderUid: cap.uid!, holderType: 'structure', ownerId: 'p1', sectorKey: 's', x: 0, y: 0, hold: { goods: { minerals: 900, alloy: 3 }, blueprints: [] }, expiresAt: null }]);
    t.svc.restore(cap);
    expect(cap.minerals).toBe(900);
    expect(cap.hold!.goods.alloy).toBe(3);
    expect(cap.hold!.goods.minerals).toBeUndefined();
  });

  it('flushDirty persists only changed storage; takeForSpill empties + deletes the row', () => {
    const t = setup();
    const cap = rec('c', 'capital', 0, 0, { minerals: 10 });
    t.registry.add(cap);
    t.svc.flushDirty();
    const first = t.ops.length;
    t.svc.flushDirty();
    expect(t.ops.length).toBe(first); // unchanged ⇒ no write
    cap.minerals = 20;
    t.svc.flushDirty();
    expect(t.ops.length).toBe(first + 1);
    const spill = t.svc.takeForSpill(cap)!;
    expect(spill.goods.minerals).toBe(20);
    expect(t.holdStore.get(cap.uid!)).toBeUndefined();
  });
});

describe('StorageService cargo access (C1)', () => {
  it('take: moves only the asked items, up to ship capacity, in ONE atomic group', () => {
    const t = setup();
    const bay = rec('b', 'cargo_bay', 0, 0, { hold: { goods: { alloy: 10, ice: 5 }, blueprints: [] } });
    t.registry.add(bay);
    t.ship({ salvage: 1 });
    t.ops.length = 0;
    const moved = t.svc.cargoTake('ship-1', 'visitor', bay, { goods: { alloy: 10 } }, 1 + 2 * 4); // room for 4 alloy
    expect(moved.goods).toEqual({ alloy: 4 });
    expect(bay.hold!.goods).toEqual({ alloy: 6, ice: 5 });
    expect(t.holdStore.get('ship-1')!.hold.goods).toEqual({ salvage: 1, alloy: 4 });
    expect(t.holdStore.get('ship-1')!.ownerId).toBe('visitor');
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
  });

  it("take: minerals come from the goods hold first, then the Capital's bank", () => {
    const t = setup();
    const cap = rec('c', 'capital', 0, 0, { minerals: 100, hold: { goods: { minerals: 30 }, blueprints: [] } });
    t.registry.add(cap);
    expect(t.svc.cargoView(cap).hold.goods.minerals).toBe(130);
    const moved = t.svc.cargoTake('ship-1', 'p1', cap, { goods: { minerals: 50 } }, 1000);
    expect(moved.goods.minerals).toBe(50);
    expect(cap.hold!.goods.minerals).toBeUndefined();
    expect(cap.minerals).toBe(80);
  });

  it("put: minerals fill a Capital's bank first; what doesn't fit stays aboard", () => {
    const t = setup();
    const bay = rec('b', 'cargo_bay', 0, 0);
    const cap = rec('c', 'capital', 50, 0);
    t.registry.add(bay);
    t.registry.add(cap);
    t.ship({ minerals: 40, core: 1000 }); // core weighs 5: 5000 > the bay's 2000
    const toCap = t.svc.cargoPut('ship-1', 'p1', cap, { goods: { minerals: 40 } });
    expect(toCap.goods.minerals).toBe(40);
    expect(cap.minerals).toBe(40);
    const toBay = t.svc.cargoPut('ship-1', 'p1', bay, { goods: { core: 1000 } });
    expect(toBay.goods.core).toBe(400);
    expect(bay.hold!.goods.core).toBe(400);
    expect(t.holdStore.get('ship-1')!.hold.goods).toEqual({ core: 600 });
  });

  it('nothing moves (and nothing is persisted) when the ship is full or the item is absent', () => {
    const t = setup();
    const bay = rec('b', 'cargo_bay', 0, 0, { hold: { goods: { alloy: 3 }, blueprints: [] } });
    t.registry.add(bay);
    t.ship({ core: 2 });
    t.ops.length = 0;
    expect(Object.keys(t.svc.cargoTake('ship-1', 'p1', bay, { goods: { alloy: 3 } }, 10).goods)).toHaveLength(0);
    expect(Object.keys(t.svc.cargoPut('ship-1', 'p1', bay, { goods: { fuel: 3 } }).goods)).toHaveLength(0);
    expect(bay.hold!.goods).toEqual({ alloy: 3 });
    expect(t.ops).toHaveLength(0);
  });
});

describe('StorageService NPC dock market (T4)', () => {
  const walletOp = { type: 'WALLET_PUT', playerId: 'p2', balance: 1 } as unknown as PersistOp;

  it('marketBuy takes from the whole network (incl. the bank) into the ship, with the wallet op in the SAME group', () => {
    const dock = rec('d', 'freight_dock', 0, 0, { owner: 'npc:traders:b', hold: { goods: { minerals: 5 }, blueprints: [] } });
    const cap = rec('c', 'capital', 400, 0, { owner: 'npc:traders:b', minerals: 100 });
    const t = setup(['d', 'c']);
    t.registry.add(dock);
    t.registry.add(cap);
    expect(t.svc.networkStock(dock, 'minerals')).toBe(105);
    t.ops.length = 0;
    expect(t.svc.marketBuy('ship-9', 'p2', dock, 'minerals', 20, [walletOp])).toBe(20);
    expect(dock.hold!.goods.minerals).toBeUndefined();
    expect(cap.minerals).toBe(85);
    expect(t.holdStore.get('ship-9')!.hold.goods.minerals).toBe(20);
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
    expect(JSON.stringify(t.ops[0])).toContain('WALLET_PUT');
  });

  it('marketSell moves ship goods into the dock, with the wallet op in the SAME group', () => {
    const dock = rec('d', 'freight_dock', 0, 0, { owner: 'npc:traders:b' });
    const t = setup();
    t.registry.add(dock);
    t.ship({ alloy: 4 });
    t.ops.length = 0;
    expect(t.svc.marketSell('ship-1', 'p1', dock, 'alloy', 3, [walletOp])).toBe(3);
    expect(dock.hold!.goods.alloy).toBe(3);
    expect(t.holdStore.get('ship-1')!.hold.goods.alloy).toBe(1);
    expect(t.ops).toHaveLength(1);
    expect(JSON.stringify(t.ops[0])).toContain('WALLET_PUT');
    expect(t.svc.dockFreeWeight(dock)).toBe(3000 - 3 * 2);
  });
});
