import { describe, it, expect } from 'vitest';
import { PlayerFireResolver, type PlayerFireResolverDeps } from './PlayerFireResolver.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import type { ShipState } from './schema/SectorState.js';
import type { Client } from 'colyseus';

/**
 * exp/fire-control P0 — each weapon GROUP (slot) keeps its own cooldown.
 * Before, one per-shooter tick gated every group, so firing group A blocked
 * group B for A's cooldown (fine with one group per ship; wrong the moment a
 * ship has two). Hand-rolled mock, like PlayerFireResolver.damageMul.test.ts.
 */
function harness(): {
  fire: (tick: number, slotId: string, shot: string) => void;
  acks: Array<{ shot: string; rejected: boolean }>;
  lastFire: Map<string, number>;
} {
  const fighter = getShipKind('fighter');
  const ship = { kind: 'fighter', alive: true, energy: 10_000, statAlloc: {}, mounts: [] } as unknown as ShipState;
  const acks: Array<{ shot: string; rejected: boolean }> = [];
  const lastFire = new Map<string, number>();
  let now = 100;
  const deps: PlayerFireResolverDeps = {
    sabF32: new Float32Array(0),
    serverTick: () => now,
    sessionToPlayer: new Map([['sess', 'p1']]),
    getActiveShip: (pid) => (pid === 'p1' ? ship : undefined),
    lastFireClientTick: lastFire,
    snapshotRing: { getPoseAt: () => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }) },
    shipPoseCache: new Map([['p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as never]]),
    playerToSlot: new Map<string, number>(),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    swarmRegistry: { get: () => null, all: () => [] },
    playerMountAngles: new Map(),
    resolveSlotMounts: (kind: ShipKind) => kind.mounts,
    resolveInstanceMounts: () => fighter.mounts,
    resolveInstanceFireMounts: () => fighter.mounts,
    mountWorldOrigin: (x, y) => ({ x, y }),
    playerHitscanDist: () => null,
    spawnServerProjectile: () => {},
    spawnServerMissile: () => null,
    applyDamage: () => {},
    broadcast: () => {},
    serverLogEvent: () => {},
    logger: { warn: () => {}, info: () => {} } as never,
  };
  const resolver = new PlayerFireResolver(deps);
  const client = {
    sessionId: 'sess',
    send: (_t: string, m: { clientShotId: string; rejected?: boolean }) =>
      acks.push({ shot: m.clientShotId, rejected: m.rejected === true }),
  } as unknown as Client;
  const fire = (tick: number, slotId: string, shot: string): void => {
    now = tick;
    resolver.resolve(client, { type: 'fire', tick, clientShotId: shot, weapon: 'hitscan', dirAngle: 0, slotId });
  };
  return { fire, acks, lastFire };
}

const rejected = (acks: Array<{ shot: string; rejected: boolean }>, shot: string): boolean =>
  acks.some((a) => a.shot === shot && a.rejected);

describe('PlayerFireResolver — per-group cooldown', () => {
  it('a second group can fire while the first is cooling down', () => {
    const h = harness();
    h.fire(100, 'fore', 'a1');
    h.fire(101, 'aft', 'b1'); // different group, 1 tick later
    expect(rejected(h.acks, 'a1')).toBe(false);
    expect(rejected(h.acks, 'b1')).toBe(false);
  });

  it('the same group is still gated by its own cooldown', () => {
    const h = harness();
    h.fire(100, 'fore', 'a1');
    h.fire(101, 'fore', 'a2');
    expect(rejected(h.acks, 'a2')).toBe(true);
  });

  it('a restored ship (empty group map) falls back to the per-shooter tick', () => {
    const h = harness();
    h.lastFire.set('p1', 100); // e.g. restored across a transit
    h.fire(101, 'fore', 'r1');
    expect(rejected(h.acks, 'r1')).toBe(true);
  });
});
