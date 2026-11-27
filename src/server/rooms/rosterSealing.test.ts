/**
 * Roster sealing (sandbox B1/B2): a sealed room binds only its own rows, a
 * real room never binds a sealed row, and the boot purge drops sealed rows
 * with their holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stop the import chain short of node:sqlite (the diagRouter.playerShips pattern).
const storeRef = { current: null as unknown };
vi.mock('../db/PersistenceWorker.js', () => ({
  getPlayerShipStore: () => storeRef.current,
  setPlayerShipStore: (s: unknown) => { storeRef.current = s; },
}));
vi.mock('../auth/AuthService.js', () => ({ getUser: () => null }));
import type { Logger } from 'pino';
import { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import { setPlayerShipStore } from '../db/PersistenceWorker.js';
import { HoldStore } from '../cargo/HoldStore.js';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import { emptyHold } from '../../core/cargo/hold.js';
import { fittedUid } from '../../shared-types/blueprints.js';
import { RosterPersistence, type RosterPose } from './RosterPersistence.js';
import { SANDBOX_SECTOR_KEY } from './sealedSectors.js';
import { pickResumableRow, purgeSealedRosterRows, rosterRowFitsRoom, rosterRowsForView, unsealedRows } from './rosterSealing.js';

const REAL = 'sol-prime';
const POSE: RosterPose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, health: 100, lastFireClientTick: 0 };
const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

let clock = 1_000;
let n = 0;
function freshStore(): PlayerShipStore {
  n = 0;
  clock = 1_000;
  return new PlayerShipStore({ generateShipId: () => `ship-${++n}`, now: () => ++clock });
}

function roster(sectorKey: string): RosterPersistence {
  return new RosterPersistence({ sectorKey: () => sectorKey, roomId: () => 'room-1', logger: noopLogger, playerToUser: new Map() });
}

function row(store: PlayerShipStore, sectorKey: string): string {
  return store.create({ playerId: 'p1', userId: null, kind: 'fighter', sectorKey, x: 0, y: 0, health: 100 }).shipId;
}

describe('rosterRowFitsRoom / pickResumableRow', () => {
  it('a sealed room takes only its own rows; a real room any unsealed row', () => {
    expect(rosterRowFitsRoom(SANDBOX_SECTOR_KEY, SANDBOX_SECTOR_KEY)).toBe(true);
    expect(rosterRowFitsRoom(REAL, SANDBOX_SECTOR_KEY)).toBe(false);
    expect(rosterRowFitsRoom(SANDBOX_SECTOR_KEY, REAL)).toBe(false);
    expect(rosterRowFitsRoom('greenfall', REAL)).toBe(true);
  });

  it('picks the most recent fitting row, skipping newer rows that do not fit', () => {
    const rows = [
      { shipId: 'a', lastSectorKey: REAL, updatedAt: 10 },
      { shipId: 'b', lastSectorKey: SANDBOX_SECTOR_KEY, updatedAt: 30 },
      { shipId: 'c', lastSectorKey: 'greenfall', updatedAt: 20 },
    ];
    expect(pickResumableRow(rows, REAL)?.shipId).toBe('c');
    expect(pickResumableRow(rows, SANDBOX_SECTOR_KEY)?.shipId).toBe('b');
    expect(pickResumableRow(rows.slice(0, 1), SANDBOX_SECTOR_KEY)).toBeNull();
  });
});

describe('RosterPersistence.bind — sealing', () => {
  let store: PlayerShipStore;
  beforeEach(() => { store = freshStore(); setPlayerShipStore(store); });

  it('B1: a sandbox join with no shipId never takes the real ship; it creates a sandbox row', () => {
    const real = row(store, REAL);
    const bound = roster(SANDBOX_SECTOR_KEY).bind('p1', null, 'fighter', POSE);
    expect(bound).not.toBe(real);
    expect(store.get(real)?.isActive).toBe(false);
    expect(store.get(bound)?.lastSectorKey).toBe(SANDBOX_SECTOR_KEY);
  });

  it('re-joining the sandbox resumes the sandbox ship (no extra row per join)', () => {
    row(store, REAL);
    const first = roster(SANDBOX_SECTOR_KEY).bind('p1', null, 'fighter', POSE);
    const again = roster(SANDBOX_SECTOR_KEY).bind('p1', null, 'fighter', POSE);
    expect(again).toBe(first);
    expect(store.count('p1')).toBe(2);
  });

  it('a sandbox room refuses an explicit real shipId', () => {
    const real = row(store, REAL);
    const bound = roster(SANDBOX_SECTOR_KEY).bind('p1', null, 'fighter', POSE, real);
    expect(bound).not.toBe(real);
    expect(store.get(real)?.isActive).toBe(false);
  });

  it('B2: a real join with no shipId never reuses a newer sandbox row', () => {
    const real = row(store, REAL);
    const sandbox = row(store, SANDBOX_SECTOR_KEY); // newer
    expect(roster(REAL).bind('p1', null, 'fighter', POSE)).toBe(real);
    expect(store.get(sandbox)?.isActive).toBe(false);
  });

  it('B2: a real room refuses an explicit sandbox shipId', () => {
    const sandbox = row(store, SANDBOX_SECTOR_KEY);
    const bound = roster(REAL).bind('p1', null, 'fighter', POSE, sandbox);
    expect(bound).not.toBe(sandbox);
    expect(store.get(bound)?.lastSectorKey).toBe(REAL);
    expect(store.get(sandbox)?.isActive).toBe(false);
  });
});

describe('unsealedRows (Hangar list)', () => {
  it('drops sealed rows', () => {
    const rows = [{ lastSectorKey: REAL }, { lastSectorKey: SANDBOX_SECTOR_KEY }];
    expect(unsealedRows(rows)).toEqual([{ lastSectorKey: REAL }]);
  });
});

describe('rosterRowsForView (in-game ship list)', () => {
  const rows = [{ lastSectorKey: REAL }, { lastSectorKey: SANDBOX_SECTOR_KEY }];
  it('a sealed view key lists only that room\'s rows', () => {
    expect(rosterRowsForView(rows, SANDBOX_SECTOR_KEY)).toEqual([{ lastSectorKey: SANDBOX_SECTOR_KEY }]);
  });
  it('no key or a real key lists the real rows only', () => {
    expect(rosterRowsForView(rows, null)).toEqual([{ lastSectorKey: REAL }]);
    expect(rosterRowsForView(rows, REAL)).toEqual([{ lastSectorKey: REAL }]);
  });
});

describe('purgeSealedRosterRows', () => {
  it('deletes sealed rows and their ship + fitted holds, keeps real ones', () => {
    const store = freshStore();
    const sink = { enqueueCritical: () => {} } as unknown as IPersistenceSink;
    const holds = new HoldStore({ persistence: () => sink, now: () => 1 });
    const real = row(store, REAL);
    const sandbox = row(store, SANDBOX_SECTOR_KEY);
    for (const id of [real, sandbox]) {
      for (const uid of [id, fittedUid(id)]) {
        holds.put({ holderUid: uid, holderType: uid === id ? 'ship' : 'fitted', ownerId: 'p1', sectorKey: null, x: null, y: null, hold: emptyHold(), expiresAt: null });
      }
    }
    expect(purgeSealedRosterRows(store, holds)).toBe(1);
    expect(store.get(sandbox)).toBeNull();
    expect(holds.get(sandbox)).toBeUndefined();
    expect(holds.get(fittedUid(sandbox))).toBeUndefined();
    expect(store.get(real)).not.toBeNull();
    expect(holds.get(real)).toBeDefined();
    expect(holds.get(fittedUid(real))).toBeDefined();
  });

  it('with a sector key, deletes only that sealed sector\'s rows', () => {
    const store = freshStore();
    const sink = { enqueueCritical: () => {} } as unknown as IPersistenceSink;
    const holds = new HoldStore({ persistence: () => sink, now: () => 1 });
    const real = row(store, REAL);
    const sandbox = row(store, SANDBOX_SECTOR_KEY);
    const battle = row(store, 'battle-subcaps');
    expect(purgeSealedRosterRows(store, holds, 'battle-subcaps')).toBe(1);
    expect(store.get(battle)).toBeNull();
    expect(store.get(sandbox)).not.toBeNull();
    expect(store.get(real)).not.toBeNull();
  });
});
