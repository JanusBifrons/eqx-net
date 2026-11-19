import { podSizeOf, podComponentIndex, POD_TIER_SPILL } from '../../shared-types/shipKinds/cargoPod.js';
import { describe, expect, it } from 'vitest';
import { LootSubsystem, LOOT_POD_TTL_MS, MAX_LIVE_LOOT_PER_SECTOR, type LootCollector, type LootSubsystemDeps } from './LootSubsystem.js';
import { HoldStore } from './HoldStore.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { Hold } from '../../shared-types/goods.js';
import { ROCK_CHUNK_PRODUCT } from '../../shared-types/items.js';
import { getShipKind, type ShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import { salvageTierMass } from '../../core/combat/salvageTargeting.js';
import type { PieceStoreView } from '../rooms/wreckLineage.js';
import { shipHitBound, shipWithinHullReach } from '../../core/combat/shipHitShape.js';

/** Distance from a hull's centre to its bare hull edge along (ux, uy), heading 0. */
function hullEdge(kindId: string, ux: number, uy: number): number {
  let d = 0;
  while (shipWithinHullReach(kindId, false, ux * (d + 2), uy * (d + 2), 0, 0, 0, 0)) d += 2;
  return d;
}

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

function setup(opts: { sectorKey?: string | null; collectors?: LootCollector[]; heldPieces?: LootSubsystemDeps['heldPieces'] } = {}) {
  const { ops, sink } = capture();
  let now = 1_000;
  const store = new HoldStore({ persistence: () => sink, now: () => now });
  const poses = new Map<string, { x: number; y: number }>();
  const despawned: string[] = [];
  const indexes = new Map<string, number>();
  const collected: Array<{ moved: Hold; podId: string }> = [];
  const collectors = opts.collectors ?? [];
  const loot = new LootSubsystem({
    holdStore: store,
    sectorKey: () => (opts.sectorKey === undefined ? 'sol-prime' : opts.sectorKey),
    now: () => now,
    deathSalt: 0, // repeatable flips; the salt itself is tested below
    spawnPodEntity: (id, x, y, _vx, _vy, index) => { poses.set(id, { x, y }); indexes.set(id, index); return true; },
    despawnPodEntity: (id) => { despawned.push(id); poses.delete(id); },
    setPodTier: (id, index) => { indexes.set(id, index); },
    podPose: (id) => poses.get(id) ?? null,
    forEachCollector: (visit) => { for (const c of collectors) visit(c); },
    onCollected: (_c, moved, podId) => { collected.push({ moved, podId }); },
    chunkOre: (_ore, _x, _y, weight) => ({ minerals: weight * 2 }), // a stand-in for OreDraw.chunkYield
    ...(opts.heldPieces ? { heldPieces: opts.heldPieces } : {}),
  });
  return { loot, store, ops, poses, indexes, despawned, collected, collectors, advance: (ms: number) => { now += ms; } };
}

const SHIP: LootCollector = { playerId: 'p1', shipInstanceId: 'ship-1', x: 0, y: 0, angle: 0, shieldUp: false, capacity: 300, kind: getShipKind('fighter') };

describe('LootSubsystem (P1a-1)', () => {
  it('a pilot flying over or touching a pod no longer loads it: pods open in the loot window (plan cargo-pods slice 14)', () => {
    const t = setup({ collectors: [{ ...SHIP }] });
    const over = t.loot.drop(h({ salvage: 10 }), 0, 0, 0, 0, { alone: true })!;
    const touching = t.loot.drop(h({ alloy: 2 }), hullEdge('fighter', 1, 0) + 4, 0, 0, 0, { alone: true })!;
    t.loot.collectTick();
    expect(t.store.get('ship-1')).toBeUndefined();
    expect(t.store.get(over)!.hold.goods.salvage).toBe(10);
    expect(t.store.get(touching)!.hold.goods.alloy).toBe(2);
    expect(t.despawned).toEqual([]);
  });

  it('an AI harvester (no window) takes a whole pod within the open reach; one further off stays', () => {
    const t = setup({ collectors: [{ ...SHIP, npc: true }] });
    const near = t.loot.drop(h({ minerals: 3 }), 60, 0, 0, 0, { alone: true })!;
    const far = t.loot.drop(h({ minerals: 4 }), 2_000, 0, 0, 0, { alone: true })!;
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.minerals).toBe(3);
    expect(t.store.get(near)).toBeUndefined();
    expect(t.store.get(far)!.hold.goods.minerals).toBe(4);
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
    const pod = t.loot.spillShipHold('ship-9', 100, 100, 0, 0, 'death', { player: true })!;
    expect(t.store.get('ship-9')).toBeUndefined();
    expect(t.store.get(pod)!.hold.goods.alloy).toBe(2);
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
  });

  it('a death flips each stack (EVE): survivors whole, the rest gone; extra included', () => {
    const goods = { alloy: 2, salvage: 30, minerals: 9, core: 1, munitions: 40, ice: 5 };
    let sawLoss = false;
    let sawKeep = false;
    for (let i = 0; i < 20; i++) {
      const t = setup();
      t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h(goods), expiresAt: null });
      const pod = t.loot.spillShipHold('ship-9', 100, 100, 0, 0, 'death', { player: true, extra: h({ fuel: 7 }), deathLoss: 'ship-9:' + i });
      expect(t.store.get('ship-9'), 'the ship hold is gone either way').toBeUndefined();
      const out = pod === null ? {} : t.store.get(pod)!.hold.goods;
      const all: Record<string, number> = { ...goods, fuel: 7 };
      for (const [id, n] of Object.entries(out)) expect(n, id).toBe(all[id]);
      const kept = Object.keys(out).length;
      if (kept < Object.keys(all).length) sawLoss = true;
      if (kept > 0) sawKeep = true;
    }
    expect(sawLoss && sawKeep).toBe(true);
  });

  it('two deaths side by side leave two pods, one per ship (never merged)', () => {
    const t = setup();
    let pods = 0;
    for (const id of ['ship-a', 'ship-b']) {
      t.store.put({ holderUid: id, holderType: 'ship', ownerId: 'p', sectorKey: null, x: null, y: null, hold: h({ alloy: 2, salvage: 3, minerals: 4, core: 1, ice: 6, fuel: 2, munitions: 9 }), expiresAt: null });
      if (t.loot.spillShipHold(id, 100, 100, 0, 0, 'death', { player: true, deathLoss: id + ':x' }) !== null) pods++;
    }
    expect(t.loot.podCount()).toBe(pods);
    expect(pods).toBe(2);
  });

  it('a death that loses every stack leaves no pod (owner 2026-11-17)', () => {
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      const t = setup();
      t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ alloy: 2 }), expiresAt: null });
      const pod = t.loot.spillShipHold('ship-9', 100, 100, 0, 0, 'death', { player: true, deathLoss: 'one:' + i });
      if (pod !== null) continue;
      seen = true;
      expect(t.loot.podCount()).toBe(0);
      expect(t.store.get('ship-9')).toBeUndefined();
    }
    expect(seen, 'some seed lost the only stack').toBe(true);
  });

  it('the same ship id dying again rolls afresh: sometimes kept, sometimes lost (owner 2026-11-18)', () => {
    // Before: the flip was seeded only by the key, so one id lost the same
    // way every time (a fixed showcase drone never dropped a pod).
    const t = setup();
    let kept = 0;
    for (let i = 0; i < 60; i++) {
      t.store.put({ holderUid: 'pose-drone-0', holderType: 'ship', ownerId: 'p', sectorKey: null, x: null, y: null, hold: h({ salvage: 21 }), expiresAt: null });
      if (t.loot.spillShipHold('pose-drone-0', 100, 100, 0, 0, 'kill', { player: false, deathLoss: 'pose-drone-0:0' }) !== null) kept++;
    }
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(50);
  });

  it('a death pod is sized to the dead ship', () => {
    const t = setup();
    t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ fuel: 4 }), expiresAt: null });
    let pod: string | null = null;
    for (let i = 0; i < 50 && pod === null; i++) {
      t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ fuel: 4 }), expiresAt: null });
      pod = t.loot.spillShipHold('ship-9', 100, 100, 0, 0, 'death', { player: false, deathLoss: 'size:' + i, size: 3 });
    }
    expect(pod).not.toBeNull();
    expect(podSizeOf(t.indexes.get(pod!)!)).toBe(3);
    // Any other drop (a cut rock, a test drop) stays size 0.
    const small = t.loot.drop(h({ salvage: 1 }), 5_000, 5_000)!;
    expect(podSizeOf(t.indexes.get(small)!)).toBe(0);
  });

  it('pods expire after the TTL and their value is removed', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 2 }), 0, 0)!;
    t.advance(LOOT_POD_TTL_MS + 1);
    t.loot.sweep();
    expect(t.store.get(pod)).toBeUndefined();
    expect(t.loot.podCount()).toBe(0);
  });

  it('expireNow drops a pod and its contents, as its TTL would', () => {
    const t = setup();
    const pod = t.loot.drop(h({ core: 1 }), 0, 0)!;
    t.loot.expireNow(pod);
    expect(t.store.get(pod)).toBeUndefined();
    expect(t.despawned).toEqual([pod]);
    expect(t.loot.isPod(pod)).toBe(false);
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

  it('a DERELICT opens like any pod: taken at once (no trickle), never merged into, persisted as derelict', () => {
    const t = setup();
    t.store.put({ holderUid: 'ship-9', holderType: 'ship', ownerId: 'p9', sectorKey: null, x: null, y: null, hold: h({ salvage: 40 }), expiresAt: null });
    const hulk = t.loot.spillShipHold('ship-9', 10, 0, 0, 0, 'abandoned', { player: true, derelict: true })!;
    expect(t.loot.isDerelict(hulk)).toBe(true);
    expect(t.store.get(hulk)!.holderType).toBe('derelict');
    // A normal drop beside it does NOT merge into the hulk.
    const other = t.loot.drop(h({ alloy: 1 }), 20, 0)!;
    expect(other).not.toBe(hulk);
    expect(t.loot.take({ ...SHIP, capacity: 1000 }, hulk, null).ok).toBe(true);
    expect(t.store.get(hulk)).toBeUndefined();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(40);
  });

  it('a pod restored after a restart keeps its size and its glow (owner 2026-11-18: essential)', () => {
    const t = setup();
    const big = t.loot.drop(h({ salvage: 30 }), 5, 6, 0, 0, { alone: true, size: 3, spill: true })!;
    const look = t.indexes.get(big)!;
    expect(look).toBe(podComponentIndex(3, POD_TIER_SPILL));
    // A fresh room (server restart) hydrates the saved record and respawns it.
    const after = setup();
    after.store.hydrate([t.store.get(big)!]);
    expect(after.loot.restore()).toBe(1);
    expect(after.indexes.get(big)).toBe(look);
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

describe('LootSubsystem: tractored wreck pieces are stored whole (piece store)', () => {
  function rig(capacity: number, startSalvage = 0) {
    const pieces = new Map<string, number>([['wreck-1', 7]]);
    const removed: string[] = [];
    const held: string[] = ['wreck-1'];
    const t = setup({
      collectors: [{ ...SHIP, capacity }],
      heldPieces: {
        any: () => held.length > 0,
        forEach: (c, visit) => { if (c.playerId === 'p1') for (const id of held) visit(id); },
        near: () => {},
        store: (id, out) => {
          const q = pieces.get(id);
          if (q === undefined) return false;
          out.qty = Math.abs(q); out.holdWeight = Math.abs(q); out.mass = 1e9; out.radius = 500; // salvage weighs 1
          out.ore = q < 0 ? { rockId: 'rock-9', resource: 'rock', perArea: 1 } : undefined; // negative: a rock piece
          return true;
        },
        remove: (id) => { pieces.delete(id); removed.push(id); },
      },
    });
    if (startSalvage > 0) t.store.put({ holderUid: 'ship-1', holderType: 'ship', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: h({ salvage: startSalvage }), expiresAt: null }, true);
    t.ops.length = 0;
    return { t, pieces, removed, held };
  }

  it('with room: the piece\'s salvage goes into the hold in ONE commit and the piece is removed (no pods needed)', () => {
    const { t, removed } = rig(300, 2);
    expect(t.loot.podCount()).toBe(0);
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(9);
    expect(removed).toEqual(['wreck-1']);
    expect(t.ops, 'one persisted write').toHaveLength(1);
    expect(t.loot.podCount(), 'no pod in between').toBe(0);
    expect(t.collected).toEqual([{ moved: h({ salvage: 7 }), podId: 'wreck-1' }]);
  });

  it('a hold without room for ALL of it changes nothing: the piece stays, no pod, no write', () => {
    const { t, removed, pieces } = rig(8, 2); // 6 free < 7
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(2);
    expect(removed).toEqual([]);
    expect(pieces.has('wreck-1')).toBe(true);
    expect(t.ops).toHaveLength(0);
    expect(t.loot.podCount()).toBe(0);
  });

  it('a held rock piece goes in whole as ONE rock chunk: its own tile, weight and hidden ore, never goods', () => {
    const { t, removed, pieces } = rig(300);
    pieces.set('wreck-1', -7); // the rig's marker: a rock piece
    t.loot.collectTick();
    expect(removed).toEqual(['wreck-1']);
    const hold = t.store.get('ship-1')!.hold;
    expect(hold.goods, 'never ore on pickup').toEqual({});
    expect(hold.packed).toHaveLength(1);
    const chunk = hold.packed![0]!;
    expect(chunk.product).toBe(ROCK_CHUNK_PRODUCT);
    expect(chunk.uid).toMatch(/^rc-/);
    expect(chunk.weight).toBe(7);
    expect(chunk.ore).toEqual({ minerals: 14 });
    expect(t.ops, 'one persisted write').toHaveLength(1);
    expect(t.loot.podCount(), 'never a pod').toBe(0);
  });

  it('a rock chunk heavier than the free hold stays where it is', () => {
    const { t, removed, pieces } = rig(5);
    pieces.set('wreck-1', -7);
    t.loot.collectTick();
    expect(removed).toEqual([]);
    expect(t.store.get('ship-1')).toBeUndefined();
  });

  it('a piece visited twice in a pass (two mounts) is stored once', () => {
    const { t, removed, held } = rig(300);
    held.push('wreck-1');
    t.loot.collectTick();
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(7);
    expect(removed).toEqual(['wreck-1']);
  });
});

describe('LootSubsystem: consumable pieces are taken in by proximity (the factory line)', () => {
  /** A destroyer whose mounts are all tractors (a mining tool: it consumes). */
  const miner = (): ShipKind => {
    const base = getShipKind('destroyer');
    return { ...base, mounts: (base.mounts ?? []).map((m): WeaponMount => ({ ...m, weaponId: 'tractor' })) };
  };
  /** `mass`: absent = 10, at hold size (the AA tier). */
  type P = { x: number; y: number; radius: number; qty: number; mass?: number; rock?: true };
  /** A point `gap` past the miner's hull edge along +y (its beam side). */
  const side = (kind: ShipKind, gap: number): number => hullEdge(kind.id, 0, 1) + gap;
  function rig(kind: ShipKind, ps: Record<string, P>, capacity = 300) {
    const removed: string[] = [];
    const reach: number[] = [];
    const t = setup({
      collectors: [{ ...SHIP, capacity, kind }],
      heldPieces: {
        any: () => true,
        forEach: () => {},
        near: (x, y, r, maxM, visit) => {
          reach.push(r);
          for (const [id, p] of Object.entries(ps)) {
            if (!removed.includes(id) && (p.mass ?? 10) <= maxM && Math.hypot(p.x - x, p.y - y) <= r + p.radius) visit(id, p.x, p.y, p.radius);
          }
        },
        store: (id, out: PieceStoreView) => {
          const p = ps[id];
          if (p === undefined || removed.includes(id)) return false;
          out.radius = p.radius; out.mass = p.mass ?? 10; out.qty = p.qty; out.holdWeight = p.qty;
          out.ore = p.rock ? { rockId: 'rock-9', resource: 'rock', perArea: 1 } : undefined;
          return true;
        },
        remove: (id) => { removed.push(id); },
      },
    });
    t.ops.length = 0;
    return { t, removed, reach };
  }

  it('a hold-size (AA-tier) wreck piece touching the hull goes in whole (one commit); an S-tier one and one off the hull stay', () => {
    const kind = miner();
    const small = 8;
    const { t, removed, reach } = rig(kind, {
      near: { x: 0, y: side(kind, small - 2), radius: small, qty: 4 },
      big: { x: 0, y: -(hullEdge(kind.id, 0, -1) + 4), radius: 12, mass: salvageTierMass('AA') * 1.5, qty: 4 },
      off: { x: 0, y: side(kind, small + 40), radius: small, qty: 4 },
    });
    t.loot.collectTick();
    expect(reach, 'pre-filter: the bounding circle of the hull').toEqual([shipHitBound(kind.id)]);
    expect(removed).toEqual(['near']);
    expect(t.store.get('ship-1')!.hold.goods.salvage).toBe(4);
    expect(t.ops, 'one persisted write').toHaveLength(1);
  });

  it('a rock piece touching the hull goes in whole as one chunk', () => {
    const kind = miner();
    const { t, removed } = rig(kind, { r: { x: 0, y: side(kind, 4), radius: 10, qty: 6, rock: true } });
    t.loot.collectTick();
    expect(removed).toEqual(['r']);
    const packed = t.store.get('ship-1')!.hold.packed ?? [];
    expect(packed.map((p) => p.product)).toEqual([ROCK_CHUNK_PRODUCT]);
  });

  it('a hold without room for it: not consumable, the piece stays', () => {
    const kind = miner();
    const { t, removed } = rig(kind, { p: { x: 0, y: side(kind, 4), radius: 10, qty: 40 } }, 30);
    t.loot.collectTick();
    expect(removed).toEqual([]);
    expect(t.store.get('ship-1')).toBeUndefined();
  });

  it('a ship with no mining tool takes nothing in (unchanged)', () => {
    const kind = getShipKind('destroyer'); // naval guns only
    const { t, removed, reach } = rig(kind, { p: { x: kind.radius, y: 0, radius: 10, qty: 4 } });
    t.loot.collectTick();
    expect(reach).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('LootSubsystem.take: the loot window (plan cargo-pods slice 10)', () => {
  // Pods dropped far off (fly-over never fires: no collectors); `take` is the only move.
  const near = (x = 0, y = 0): LootCollector => ({ ...SHIP, x, y });

  it('Take all moves the whole pod into the ship and deletes the pod in ONE atomic group', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 5, alloy: 2 }), 60, 0, 0, 0, { alone: true })!;
    t.ops.length = 0;
    const r = t.loot.take(near(), pod, null);
    expect(r.ok).toBe(true);
    expect(t.store.get('ship-1')!.hold.goods).toEqual({ salvage: 5, alloy: 2 });
    expect(t.store.get(pod)).toBeUndefined();
    expect(t.despawned).toEqual([pod]);
    expect(t.ops).toHaveLength(1);
    expect(t.ops[0]!.type).toBe('GROUP');
    expect(t.collected).toEqual([{ moved: h({ salvage: 5, alloy: 2 }), podId: pod }]);
  });

  it('taking one stack leaves the rest in the pod (pod row updated, entity kept)', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 5, alloy: 2 }), 60, 0, 0, 0, { alone: true })!;
    const r = t.loot.take(near(), pod, { goods: { alloy: 2 } });
    expect(r).toEqual({ ok: true, moved: h({ alloy: 2 }) });
    expect(t.store.get('ship-1')!.hold.goods).toEqual({ alloy: 2 });
    expect(t.store.get(pod)!.hold.goods).toEqual({ salvage: 5 });
    expect(t.despawned).toEqual([]);
  });

  it('out of reach: nothing moves', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 5 }), 2_000, 0, 0, 0, { alone: true })!;
    expect(t.loot.take(near(), pod, null)).toEqual({ ok: false, reason: 'out_of_reach' });
    expect(t.store.get('ship-1')).toBeUndefined();
    expect(t.store.get(pod)!.hold.goods.salvage).toBe(5);
  });

  it('weight is the only limit: a near-full hold takes what fits, the rest stays; a full one takes nothing', () => {
    const t = setup();
    const pod = t.loot.drop(h({ salvage: 10 }), 60, 0, 0, 0, { alone: true })!;
    const r = t.loot.take({ ...near(), capacity: 4 }, pod, { goods: { salvage: 10 } });
    expect(r).toEqual({ ok: true, moved: h({ salvage: 4 }) });
    expect(t.store.get(pod)!.hold.goods.salvage).toBe(6);
    expect(t.loot.take({ ...near(), capacity: 4 }, pod, null)).toEqual({ ok: false, reason: 'hold_full' });
    expect(t.store.get(pod)!.hold.goods.salvage).toBe(6);
  });

  it('a pod that is gone answers gone', () => {
    const t = setup();
    expect(t.loot.take(near(), 'no-such-pod', null)).toEqual({ ok: false, reason: 'gone' });
  });
});
