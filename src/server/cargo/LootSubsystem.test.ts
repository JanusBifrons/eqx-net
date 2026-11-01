import { describe, expect, it } from 'vitest';
import { LootSubsystem, LOOT_POD_TTL_MS, MAX_LIVE_LOOT_PER_SECTOR, DERELICT_SALVAGE_STEP, type LootCollector } from './LootSubsystem.js';
import { HoldStore } from './HoldStore.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { Hold } from '../../shared-types/goods.js';

function capture() {
  const ops: PersistOp[] = [];
  const sink: IPersistenceSink = {
    enqueueCritical: (op) => { ops.push(op); },
    enqueueVolatile: () => {},
    enqueueCriticalAwaitable: () => Promise.resolve({}),
    shutdown: () => Promise.resolve({ drained: 0 }),
  };
  return { ops, sink };
}

function h(goods: Hold['goods']): Hold {
  return { goods: { ...goods }, blueprints: [] };
}

function setup(opts: { sectorKey?: string | null; collectors?: LootCollector[] } = {}) {
  const { ops, sink } = capture();
  let now = 1_000;
  const store = new HoldStore({ persistence: () => sink, now: () => now });
  const poses = new Map<string, { x: number; y: number }>();
  const despawned: string[] = [];
  const collected: Array<{ moved: Hold; podId: string }> = [];
  const collectors = opts.collectors ?? [];
  const loot = new LootSubsystem({
    holdStore: store,
    sectorKey: () => (opts.sectorKey === undefined ? 'sol-prime' : opts.sectorKey),
    now: () => now,
    spawnPodEntity: (id, x, y) => { poses.set(id, { x, y }); return true; },
    despawnPodEntity: (id) => { despawned.push(id); poses.delete(id); },
    setPodTier: () => {},
    podPose: (id) => poses.get(id) ?? null,
    forEachCollector: (visit) => { for (const c of collectors) visit(c); },
    onCollected: (_c, moved, podId) => { collected.push({ moved, podId }); },
  });
  return { loot, store, ops, poses, despawned, collected, collectors, advance: (ms: number) => { now += ms; } };
}

const SHIP: LootCollector = { playerId: 'p1', shipInstanceId: 'ship-1', x: 0, y: 0, capacity: 300 };

describe('LootSubsystem (P1a-1)', () => {
  it('fly-over pickup moves the pod into the ship hold and deletes the pod in ONE atomic group', () => {
    const t = setup({ collectors: [{ ...SHIP }] });
    const pod = t.loot.drop(h({ salvage: 10 }), 30, 0)!;
    t.ops.length = 0;
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(10);
    expect(t.store.get(pod)).toBeUndefined();
    expect(t.despawned).toEqual([pod]);
    // Exactly one persisted op, and it is an atomic GROUP (ship put + pod delete).
    expect(t.ops).toHaveLength(1);
    const g = t.ops[0]!;
    expect(g.type).toBe('GROUP');
    if (g.type === 'GROUP') {
      expect(g.ops.map((o) => o.type).sort()).toEqual(['HOLD_DELETE', 'HOLD_PUT']);
    }
  });

  it('a full hold takes what fits; the rest stays in the pod', () => {
    const t = setup({ collectors: [{ ...SHIP, capacity: 4 }] });
    const pod = t.loot.drop(h({ salvage: 10 }), 0, 0)!;
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(4);
    expect(t.store.get(pod)!.hold.goods.salvage).toBe(6);
    expect(t.despawned).toEqual([]);
  });

  it('out-of-range pods are not collected', () => {
    const t = setup({ collectors: [{ ...SHIP }] });
    t.loot.drop(h({ salvage: 3 }), 500, 0);
    t.loot.collectTick();
    expect(t.store.get('ship-1')).toBeUndefined();
  });

  it('a nearby drop merges into an existing pod instead of spawning', () => {
    const t = setup();
    const a = t.loot.drop(h({ salvage: 3 }), 0, 0)!;
    const b = t.loot.drop(h({ salvage: 4 }), 20, 0)!;
    expect(b).toBe(a);
    expect(t.loot.podCount()).toBe(1);
    expect(t.store.get(a)!.hold.goods.salvage).toBe(7);
  });

  it('at the per-sector cap a new drop merges into the nearest pod (value never evicted)', () => {
    const t = setup();
    for (let i = 0; i < MAX_LIVE_LOOT_PER_SECTOR; i++) t.loot.drop(h({ salvage: 1 }), i * 1000, 0);
    expect(t.loot.podCount()).toBe(MAX_LIVE_LOOT_PER_SECTOR);
    t.loot.drop(h({ salvage: 5 }), 3010, 0);
    expect(t.loot.podCount()).toBe(MAX_LIVE_LOOT_PER_SECTOR);
    let total = 0;
    for (const id of t.loot.podIds()) total += t.store.get(id)!.hold.goods.salvage ?? 0;
    expect(total).toBe(MAX_LIVE_LOOT_PER_SECTOR + 5);
  });

  it('spilling a ship hold creates a pod and deletes the ship hold atomically', () => {
    const t = setup();
    t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ alloy: 2 }), expiresAt: null });
    t.ops.length = 0;
    const pod = t.loot.spillShipHold('ship-9', 100, 100, 0, 0, 'death')!;
    expect(t.store.get('ship-9')).toBeUndefined();
    expect(t.store.get(pod)!.hold.goods.alloy).toBe(2);
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
  });

  it('pods expire after the TTL and their value is removed', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 2 }), 0, 0)!;
    t.advance(LOOT_POD_TTL_MS + 1);
    t.loot.sweep();
    expect(t.store.get(pod)).toBeUndefined();
    expect(t.loot.podCount()).toBe(0);
  });

  it('a destroyed pod deletes its contents', () => {
    const t = setup();
    const pod = t.loot.drop(h({ core: 1 }), 0, 0)!;
    t.loot.onPodDestroyed(pod);
    expect(t.store.get(pod)).toBeUndefined();
  });

  it('restore() respawns persisted pods for this sector only', () => {
    const t = setup();
    t.store.hydrate([
      { holderUid: 'pod-a', holderType: 'pod', ownerId: null, sectorKey: 'sol-prime', x: 5, y: 6, hold: h({ salvage: 1 }), expiresAt: null },
      { holderUid: 'pod-b', holderType: 'pod', ownerId: null, sectorKey: 'other', x: 5, y: 6, hold: h({ salvage: 1 }), expiresAt: null },
    ]);
    expect(t.loot.restore()).toBe(1);
    expect(t.loot.isPod('pod-a')).toBe(true);
    expect(t.loot.isPod('pod-b')).toBe(false);
  });

  it('a DERELICT is salvaged over time (bounded per step), never merged into, and persisted as derelict', () => {
    const t = setup({ collectors: [{ ...SHIP, capacity: 1000 }] });
    t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ salvage: 40 }), expiresAt: null });
    const hulk = t.loot.spillShipHold('ship-9', 10, 0, 0, 0, 'abandoned', true)!;
    expect(t.loot.isDerelict(hulk)).toBe(true);
    expect(t.store.get(hulk)!.holderType).toBe('derelict');
    // A normal drop beside it does NOT merge into the hulk.
    const other = t.loot.drop(h({ alloy: 1 }), 20, 0)!;
    expect(other).not.toBe(hulk);
    // One collect step moves at most DERELICT_SALVAGE_STEP weight from the hulk.
    t.loot.collectTick();
    const after1 = t.store.get(hulk)!.hold.goods.salvage!;
    expect(after1).toBe(40 - DERELICT_SALVAGE_STEP);
    // Keep salvaging until the hulk is empty, then it's gone.
    for (let i = 0; i < 10 && t.store.get(hulk); i++) t.loot.collectTick();
    expect(t.store.get(hulk)).toBeUndefined();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(40);
  });

  it('restore() brings derelicts back as derelicts', () => {
    const t = setup();
    t.store.hydrate([{ holderUid: 'pod-d', holderType: 'derelict', ownerId: null, sectorKey: 'sol-prime', x: 1, y: 1, hold: h({ salvage: 5 }), expiresAt: null }]);
    expect(t.loot.restore()).toBe(1);
    expect(t.loot.isDerelict('pod-d')).toBe(true);
  });

  it('engineering rooms (no sector key) never persist', () => {
    const t = setup({ sectorKey: null });
    t.loot.drop(h({ salvage: 1 }), 0, 0);
    expect(t.ops).toHaveLength(0);
  });
});
