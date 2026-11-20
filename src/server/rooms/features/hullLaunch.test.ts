/**
 * `HullHandOff.launchNewHull` — a brand-new owned hull (a Shipyard build or an
 * unpacked crate) gets ONE roster row and goes into the world through the
 * hand-off arrival path (`receiveHandedOffHull` → `restoreLingeringHulls`),
 * guarding where it parks. Hand-rolled host mocks; the roster is a real
 * in-memory `PlayerShipStore`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerShipStore, ROSTER_SOFT_GUARD } from '../../playerShips/PlayerShipStore.js';

// The persistence singleton pulls in node:sqlite; stub it with a swappable store.
const storeRef = { current: new PlayerShipStore() };
vi.mock('../../db/PersistenceWorker.js', () => ({ getPlayerShipStore: () => storeRef.current }));

import { HullHandOff, NEW_HULL_PARK_OFFSET, newHullOrigin, type HullHandOffHost } from './hullHandOff.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { gateColliderBoxes, worldToLocal } from '../../../core/structures/gateGeometry.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { qualityHullFactor } from '../../../shared-types/blueprints.js';
import type { SectorSnapshotLingeringHull } from '../SectorSnapshot.js';

/** A cargo bay's origin: the hull parks beside it. */
const beside = (x: number, y: number) => newHullOrigin('cargo_bay', x, y, 0, 'gunship');

function host(opts: { freeSlots?: number; placeFails?: boolean; online?: Map<string, string | null> } = {}) {
  const restored: SectorSnapshotLingeringHull[] = [];
  const orders: Array<{ caller: string; ids: readonly string[]; order: unknown }> = [];
  const lingering = new Map<string, number>();
  const free = Array.from({ length: opts.freeSlots ?? 4 }, (_, i) => i);
  const h = {
    sectorKey: () => 'sol-prime',
    serverTick: () => 0,
    freeSlots: () => free,
    lingeringSlots: lingering,
    playerToUser: opts.online ?? new Map<string, string | null>(),
    landingPoint: (_pid: string, x: number, y: number) => ({ x, y: y + 50 }),
    snapshotRestore: () => ({
      restoreLingeringHulls: (rows: readonly SectorSnapshotLingeringHull[]) => {
        for (const r of rows) {
          restored.push(r);
          if (!opts.placeFails) lingering.set(r.shipInstanceId, free.pop()!);
        }
      },
    }),
    warpTravel: () => ({ markArrived: () => {} }),
    fleet: { applyOrder: (caller: string, ids: readonly string[], order: unknown) => { orders.push({ caller, ids: [...ids], order }); return ids; } },
  } as unknown as HullHandOffHost;
  return { hand: new HullHandOff(h), restored, lingering, orders };
}

describe('HullHandOff.launchNewHull', () => {
  let store: PlayerShipStore;
  beforeEach(() => {
    store = new PlayerShipStore();
    storeRef.current = store;
  });

  it('parks a live, defending hull beside the maker, hull scaled by quality', () => {
    const { hand, restored, lingering, orders } = host();
    const res = hand.launchNewHull('alice', 'gunship', 80, beside(100, -200), true);
    expect(res.ok && res.live).toBe(true);
    if (!res.ok) return;
    const row = store.get(res.shipId)!;
    const health = Math.round(getShipKind('gunship').maxHealth * qualityHullFactor(80));
    expect(row).toMatchObject({ playerId: 'alice', kind: 'gunship', hullQuality: 80, health, lastSectorKey: 'sol-prime' });
    expect(row.lastX).toBe(100 + NEW_HULL_PARK_OFFSET);
    expect(row.lastY).toBe(-150);
    expect(lingering.has(res.shipId)).toBe(true);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ shipInstanceId: res.shipId, playerId: 'alice', health, mode: 'defend', stance: 'defensive', modeData: { x: row.lastX, y: row.lastY } });
    expect(orders, 'parked beside its maker: no order').toHaveLength(0);
  });

  describe('out of a Shipyard (loop 3M)', () => {
    const fp = getStructureKind('shipyard').footprint;
    const local = { x: 0, y: 0 };
    for (const rot of [0, 90, 180, 270]) {
      it(`a new hull starts in the yard with a move order (yard turned ${rot}°)`, () => {
        const { hand, restored, orders } = host();
        const yx = 1000, yy = -500, a = (rot * Math.PI) / 180;
        const res = hand.launchNewHull('alice', 'gunship', 0, newHullOrigin('shipyard', yx, yy, rot, 'gunship'), true);
        expect(res.ok && res.live).toBe(true);
        if (!res.ok) return;
        const r = restored[0]!;
        // On the slipway inside the frame: within the footprint, in no solid part.
        worldToLocal(yx, yy, a, r.x, r.y, local);
        expect(Math.abs(local.x)).toBeLessThan(fp.w / 2);
        expect(Math.abs(local.y)).toBeLessThan(fp.h / 2);
        for (const b of gateColliderBoxes('shipyard')!) {
          expect(Math.abs(local.x - b.cx) < b.hw && Math.abs(local.y - b.cy) < b.hh, 'not inside a solid part').toBe(false);
        }
        // Heading = the bow (local +x): the nose is (-sin, cos) of the angle.
        expect(-Math.sin(r.angle)).toBeCloseTo(Math.cos(a), 6);
        expect(Math.cos(r.angle)).toBeCloseTo(Math.sin(a), 6);
        expect(store.get(res.shipId)).toMatchObject({ lastX: r.x, lastY: r.y });
        // The owner's ordinary Move order, to a park spot beyond the bow edge
        // (nudged by `landingPoint`, mocked as +50 y).
        expect(orders).toHaveLength(1);
        expect(orders[0]!.caller).toBe('alice');
        expect(orders[0]!.ids).toEqual([res.shipId]);
        const reach = fp.w / 2 + NEW_HULL_PARK_OFFSET;
        expect(orders[0]!.order).toMatchObject({ kind: 'move' });
        const o = orders[0]!.order as { x: number; y: number };
        expect(o.x).toBeCloseTo(yx + reach * Math.cos(a), 6);
        expect(o.y).toBeCloseTo(yy + reach * Math.sin(a) + 50, 6);
      });
    }

    it('a hull too wide for the slipway (the Barge) appears beyond the bow, no order', () => {
      const { hand, restored, orders } = host();
      const o = newHullOrigin('shipyard', 0, 0, 0, 'barge');
      expect(o.flyOut).toBe(false);
      const res = hand.launchNewHull('alice', 'barge', 0, o, true);
      expect(res.ok && res.live).toBe(true);
      expect(restored[0]).toMatchObject({ x: fp.w / 2 + NEW_HULL_PARK_OFFSET, y: 50 });
      expect(orders).toHaveLength(0);
    });

    it('no slot: nothing spawned and no order (the yard keeps its crate)', () => {
      const { hand, orders } = host({ freeSlots: 0 });
      expect(hand.launchNewHull('alice', 'gunship', 0, newHullOrigin('shipyard', 0, 0, 0, 'gunship'), true)).toEqual({ ok: false, reason: 'no_slot' });
      expect(orders).toHaveLength(0);
    });
  });

  it('owner offline: still parked live; userId comes from their roster', () => {
    store.create({ playerId: 'bob', userId: 'user-bob', kind: 'fighter', sectorKey: 'sol-prime', x: 0, y: 0, health: 100 });
    const { hand } = host();
    const res = hand.launchNewHull('bob', 'gunship', 0, beside(0, 0), true);
    expect(res.ok && res.live).toBe(true);
    if (res.ok) expect(store.get(res.shipId)!.userId).toBe('user-bob');
  });

  it('roster cap reached: nothing created', () => {
    for (let i = 0; i < ROSTER_SOFT_GUARD; i++) store.create({ playerId: 'carol', userId: null, kind: 'scout', sectorKey: 'sol-prime', x: 0, y: 0, health: 100 });
    const { hand, restored } = host();
    expect(hand.launchNewHull('carol', 'gunship', 0, beside(0, 0), true)).toEqual({ ok: false, reason: 'roster_full' });
    expect(store.listByPlayer('carol')).toHaveLength(ROSTER_SOFT_GUARD);
    expect(restored).toHaveLength(0);
  });

  it('no free lingering slot: the yard gets nothing (keeps its crate); an unpack keeps the roster row', () => {
    const { hand, restored } = host({ freeSlots: 0 });
    expect(hand.launchNewHull('dave', 'gunship', 0, beside(0, 0), true)).toEqual({ ok: false, reason: 'no_slot' });
    expect(store.listByPlayer('dave')).toHaveLength(0);
    expect(restored).toHaveLength(0);
    const unpacked = hand.launchNewHull('dave', 'gunship', 0, beside(0, 0), false);
    expect(unpacked.ok && !unpacked.live).toBe(true);
    expect(store.listByPlayer('dave')).toHaveLength(1);
  });

  it('a failed placement removes the roster row it made (the yard falls back to a crate)', () => {
    const { hand } = host({ placeFails: true });
    expect(hand.launchNewHull('erin', 'gunship', 0, beside(0, 0), true)).toEqual({ ok: false, reason: 'no_slot' });
    expect(store.listByPlayer('erin')).toHaveLength(0);
  });
});
