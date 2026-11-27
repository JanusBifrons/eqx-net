/**
 * Fleet salvage order slice 3 (`wingmanSalvageOrder.ts`): travel into reach,
 * hold in reach, retarget to the largest live piece of the wreck lineage on
 * a split, and finish (nothing left, hold full, too small to lock).
 */
import { describe, expect, it } from 'vitest';
import type { AiEntityPoseOut, IAiBehaviour } from '../../../core/contracts/IAiBehaviour.js';
import type { FleetShipOrders } from '../../fleet/fleetShipOrders.js';
import type { SwarmEntityRecord } from '../../net/SwarmEntityRegistry.js';
import type { LockLineageSource } from '../lockSalvage.js';
import {
  SALVAGE_DONE, SALVAGE_RETARGETED, SALVAGE_WORKING, STANDOFF_REACH_FRAC, WingmanSalvageOrder,
} from './wingmanSalvageOrder.js';

const SKIFF = 'mining-skiff';

interface Piece { rec: SwarmEntityRecord; x: number; y: number }

function world(pieces: Piece[], lineage: Record<number, number[]> = {}, full = false) {
  const byEid = new Map<number, Piece>();
  for (const p of pieces) byEid.set(p.rec.entityId, p);
  const src: LockLineageSource = {
    rootOf: (key) => {
      const n = Number(key.slice(2));
      for (const [root, ids] of Object.entries(lineage)) if (ids.includes(n)) return Number(root);
      return -1;
    },
    keysOf: (root, out) => { for (const n of lineage[root] ?? []) if (byEid.has(n)) out.push(`s:${n}`); },
  } as LockLineageSource;
  const host = {
    swarmRegistry: { getByEntityId: (n: number) => byEid.get(n)?.rec ?? null },
    swarmEntityPoseInto: (id: string, out: AiEntityPoseOut) => {
      for (const p of byEid.values()) if (p.rec.id === id) { out.x = p.x; out.y = p.y; return true; }
      return false;
    },
    lingeringPoseCache: new Map<string, { x: number; y: number }>(),
    state: () => ({ ships: { get: (id: string) => (id === 's1' ? { kind: SKIFF } : undefined) } }),
    salvageLineage: () => src,
    salvageHoldFull: () => full,
  };
  return { host, byEid };
}

function piece(eid: number, radius: number, x = 0, y = 0): Piece {
  return { rec: { id: `w${eid}`, entityId: eid, slot: eid, kind: 4, radius } as SwarmEntityRecord, x, y };
}

function brain(travelState = 0) {
  const calls: { travel: Array<[number, number]> } = { travel: [] };
  const b = {
    setTravel: (x: number, y: number) => { calls.travel.push([x, y]); },
    getTravelState: () => travelState,
  } as unknown as IAiBehaviour;
  return { b, calls };
}

function orders(eid: number): FleetShipOrders {
  return { order: { kind: 'salvage', targetId: `swarm-${eid}` }, mode: 'guard', post: null } as unknown as FleetShipOrders;
}

describe('WingmanSalvageOrder', () => {
  it('canLock: a big wreck piece yes, a small drone scrap no (S mount lockSeconds is Infinity)', () => {
    const { host } = world([]);
    const so = new WingmanSalvageOrder(host);
    expect(so.canLock(SKIFF, 300)).toBe(true);
    expect(so.canLock(SKIFF, 6)).toBe(false);
  });

  it('out of reach: travels to the stand-off point on the line to the hull', () => {
    const p = piece(7, 300);
    const { host } = world([p]);
    const so = new WingmanSalvageOrder(host);
    const { b, calls } = brain();
    const holds: Array<[number, number]> = [];
    const w = orders(7);
    expect(so.step('s1', SKIFF, w, b, 0, 20000, (_b, x, y) => holds.push([x, y]))).toBe(SALVAGE_WORKING);
    expect(calls.travel).toHaveLength(1);
    const [tx, ty] = calls.travel[0]!;
    expect(tx).toBeCloseTo(0);
    expect(ty).toBeGreaterThan(300);
    expect(ty).toBeLessThan(20000);
    // Stand-off: piece edge + STANDOFF_REACH_FRAC of the shortest salvage reach.
    const reach = (ty - 300) / STANDOFF_REACH_FRAC;
    expect(reach).toBeGreaterThan(500);
    expect(holds).toHaveLength(0);
  });

  it('in reach: holds where it is (fresh) and does not travel', () => {
    const p = piece(7, 300);
    const { host } = world([p]);
    const so = new WingmanSalvageOrder(host);
    const { b, calls } = brain();
    const holds: Array<[number, number]> = [];
    host.lingeringPoseCache.set('s1', { x: 0, y: 500 });
    expect(so.fly('s1', orders(7).order!, b, (_b, x, y) => holds.push([x, y]))).toBe(true);
    expect(calls.travel).toHaveLength(0);
    expect(holds).toEqual([[0, 500]]);
  });

  it('on the way: a steady step does not re-plan', () => {
    const p = piece(7, 300);
    const { host } = world([p]);
    const so = new WingmanSalvageOrder(host);
    const { b, calls } = brain(1);
    expect(so.step('s1', SKIFF, orders(7), b, 0, 20000, () => {})).toBe(SALVAGE_WORKING);
    expect(calls.travel).toHaveLength(0);
  });

  it('the piece split: retargets to the largest live piece of its lineage', () => {
    const a = piece(7, 300), b1 = piece(8, 120), b2 = piece(9, 200);
    const { host, byEid } = world([a, b1, b2], { 1: [7, 8, 9] });
    const so = new WingmanSalvageOrder(host);
    const { b } = brain(2);
    const w = orders(7);
    expect(so.step('s1', SKIFF, w, b, 0, 400, () => {})).toBe(SALVAGE_WORKING);
    byEid.delete(7);
    expect(so.step('s1', SKIFF, w, b, 0, 400, () => {})).toBe(SALVAGE_RETARGETED);
    expect(w.order).toEqual({ kind: 'salvage', targetId: 'swarm-9' });
    byEid.delete(9);
    expect(so.step('s1', SKIFF, w, b, 0, 400, () => {})).toBe(SALVAGE_RETARGETED);
    expect(w.order).toEqual({ kind: 'salvage', targetId: 'swarm-8' });
    byEid.delete(8);
    expect(so.step('s1', SKIFF, w, b, 0, 400, () => {})).toBe(SALVAGE_DONE);
  });

  it('finishes when the hold is full', () => {
    const { host } = world([piece(7, 300)], {}, true);
    const so = new WingmanSalvageOrder(host);
    expect(so.step('s1', SKIFF, orders(7), brain().b, 0, 400, () => {})).toBe(SALVAGE_DONE);
  });

  it('finishes at once on a piece too small to lock', () => {
    const { host } = world([piece(7, 6)]);
    const so = new WingmanSalvageOrder(host);
    const { b, calls } = brain();
    expect(so.step('s1', SKIFF, orders(7), b, 0, 20000, () => {})).toBe(SALVAGE_DONE);
    expect(calls.travel).toHaveLength(0);
  });

  it('a piece with no lineage that is gone finishes the order', () => {
    const { host, byEid } = world([piece(7, 300)]);
    const so = new WingmanSalvageOrder(host);
    const w = orders(7);
    so.step('s1', SKIFF, w, brain(2).b, 0, 400, () => {});
    byEid.delete(7);
    expect(so.step('s1', SKIFF, w, brain(2).b, 0, 400, () => {})).toBe(SALVAGE_DONE);
  });
});
