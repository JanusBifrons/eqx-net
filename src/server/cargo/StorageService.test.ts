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
  const ship = (goods: Record<string, number>, credits = 0) =>
    holdStore.put({ holderUid: 'ship-1', holderType: 'ship', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: { goods, credits, blueprints: [] }, expiresAt: null });
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
    t.ship({ minerals: 50, salvage: 7 }, 30);
    t.ops.length = 0;
    const moved = t.svc.deposit('ship-1', 'p1', cap);
    expect(moved.goods.salvage).toBe(7);
    expect(moved.credits).toBe(30);
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
    const bay = rec('b', 'cargo_bay', 100, 0, { hold: { goods: { salvage: 5 }, credits: 0, blueprints: [] } });
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
    t.holdStore.hydrate([{ holderUid: cap.uid!, holderType: 'structure', ownerId: 'p1', sectorKey: 's', x: 0, y: 0, hold: { goods: { minerals: 900, alloy: 3 }, credits: 50, blueprints: [] }, expiresAt: null }]);
    t.svc.restore(cap);
    expect(cap.minerals).toBe(900);
    expect(cap.hold!.goods.alloy).toBe(3);
    expect(cap.hold!.goods.minerals).toBeUndefined();
    expect(cap.hold!.credits).toBe(50);
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
