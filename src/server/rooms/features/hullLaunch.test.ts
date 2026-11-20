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

import { HullHandOff, NEW_HULL_PARK_OFFSET, type HullHandOffHost } from './hullHandOff.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { qualityHullFactor } from '../../../shared-types/blueprints.js';
import type { SectorSnapshotLingeringHull } from '../SectorSnapshot.js';

function host(opts: { freeSlots?: number; placeFails?: boolean; online?: Map<string, string | null> } = {}) {
  const restored: SectorSnapshotLingeringHull[] = [];
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
  } as unknown as HullHandOffHost;
  return { hand: new HullHandOff(h), restored, lingering };
}

describe('HullHandOff.launchNewHull', () => {
  let store: PlayerShipStore;
  beforeEach(() => {
    store = new PlayerShipStore();
    storeRef.current = store;
  });

  it('parks a live, defending hull beside the maker, hull scaled by quality', () => {
    const { hand, restored, lingering } = host();
    const res = hand.launchNewHull('alice', 'gunship', 80, 100, -200, true);
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
  });

  it('owner offline: still parked live; userId comes from their roster', () => {
    store.create({ playerId: 'bob', userId: 'user-bob', kind: 'fighter', sectorKey: 'sol-prime', x: 0, y: 0, health: 100 });
    const { hand } = host();
    const res = hand.launchNewHull('bob', 'gunship', 0, 0, 0, true);
    expect(res.ok && res.live).toBe(true);
    if (res.ok) expect(store.get(res.shipId)!.userId).toBe('user-bob');
  });

  it('roster cap reached: nothing created', () => {
    for (let i = 0; i < ROSTER_SOFT_GUARD; i++) store.create({ playerId: 'carol', userId: null, kind: 'scout', sectorKey: 'sol-prime', x: 0, y: 0, health: 100 });
    const { hand, restored } = host();
    expect(hand.launchNewHull('carol', 'gunship', 0, 0, 0, true)).toEqual({ ok: false, reason: 'roster_full' });
    expect(store.listByPlayer('carol')).toHaveLength(ROSTER_SOFT_GUARD);
    expect(restored).toHaveLength(0);
  });

  it('no free lingering slot: the yard gets nothing (keeps its crate); an unpack keeps the roster row', () => {
    const { hand, restored } = host({ freeSlots: 0 });
    expect(hand.launchNewHull('dave', 'gunship', 0, 0, 0, true)).toEqual({ ok: false, reason: 'no_slot' });
    expect(store.listByPlayer('dave')).toHaveLength(0);
    expect(restored).toHaveLength(0);
    const unpacked = hand.launchNewHull('dave', 'gunship', 0, 0, 0, false);
    expect(unpacked.ok && !unpacked.live).toBe(true);
    expect(store.listByPlayer('dave')).toHaveLength(1);
  });

  it('a failed placement removes the roster row it made (the yard falls back to a crate)', () => {
    const { hand } = host({ placeFails: true });
    expect(hand.launchNewHull('erin', 'gunship', 0, 0, 0, true)).toEqual({ ok: false, reason: 'no_slot' });
    expect(store.listByPlayer('erin')).toHaveLength(0);
  });
});
