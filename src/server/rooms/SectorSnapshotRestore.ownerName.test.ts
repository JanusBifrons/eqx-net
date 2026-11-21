/**
 * Smoke-test bug: a hull built at the player's own Shipyard parked outside the
 * yard read "Abandoned hull" in the inspector, though its owner was known. A
 * yard-built hull (like a fleet-warp arrival or a restart restore) comes into
 * the world through `restoreLingeringHulls`, which never set the hull's
 * `displayName` (the "whose hull" line a parked hull carries). The name must
 * come from the roster row's account, the same label a joining pilot gets.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../auth/AuthService.js', () => ({
  getUser: (id: string) =>
    id === 'user-1' ? { id, email: 'owner@example.test', displayName: 'Captain Owner' }
    : id === 'user-2' ? { id, email: 'noname@example.test', displayName: null }
    : null,
}));

// The unit config has no decorator transform: a plain stand-in for the schema class.
vi.mock('./schema/SectorState.js', () => ({ ShipState: class { displayName = ''; } }));

const rosterRows = new Map<string, { userId: string | null; lastSectorKey: string }>();
vi.mock('../db/PersistenceWorker.js', () => ({
  getPlayerShipStore: () => ({
    get: (id: string) => {
      const r = rosterRows.get(id);
      return r === undefined ? null : { shipId: id, level: 1, statAlloc: {}, mounts: [], ...r };
    },
  }),
}));

import { SectorSnapshotRestore, type SectorSnapshotRestoreHost } from './SectorSnapshotRestore.js';

function makeRestore(): { restore: SectorSnapshotRestore; ships: Map<string, { displayName: string }> } {
  const ships = new Map<string, { displayName: string }>();
  const host = {
    state: () => ({ ships }),
    sabF32: () => new Float32Array(4096),
    freeSlots: () => [0, 1, 2],
    sectorKey: () => 'sol',
    serverTick: () => 0,
    wingmen: () => ({ attachWingman: () => undefined }),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    ownerlessShips: new Map(),
    snapshotRing: { registerEntity: () => undefined },
    fleet: { exportShip: () => undefined, isAttached: () => false, restoreShip: () => undefined },
    logger: { warn: () => undefined, error: () => undefined },
    shipHullMax: (m: number) => m,
    postToWorker: () => undefined,
    applyStatMulToWorker: () => undefined,
  } as unknown as SectorSnapshotRestoreHost;
  return { restore: new SectorSnapshotRestore(host), ships };
}

function hullRow(shipInstanceId: string) {
  return {
    shipInstanceId, playerId: 'player-1', kind: 'interceptor',
    x: 10, y: 20, vx: 0, vy: 0, angle: 0, angvel: 0, health: 100, shieldDown: false,
  };
}

describe('restoreLingeringHulls owner name', () => {
  it('a yard-launched parked hull carries its owner\'s display name, not "Abandoned hull"', () => {
    rosterRows.set('ship-yard', { userId: 'user-1', lastSectorKey: 'sol' });
    const { restore, ships } = makeRestore();
    restore.restoreLingeringHulls([hullRow('ship-yard')]);
    expect(ships.get('ship-yard')?.displayName).toBe('Captain Owner');
  });

  it('falls back to the account email like a joining pilot; no account leaves it empty', () => {
    rosterRows.set('ship-email', { userId: 'user-2', lastSectorKey: 'sol' });
    rosterRows.set('ship-anon', { userId: null, lastSectorKey: 'sol' });
    const { restore, ships } = makeRestore();
    restore.restoreLingeringHulls([hullRow('ship-email'), hullRow('ship-anon')]);
    expect(ships.get('ship-email')?.displayName).toBe('noname@example.test');
    expect(ships.get('ship-anon')?.displayName).toBe('');
  });
});
