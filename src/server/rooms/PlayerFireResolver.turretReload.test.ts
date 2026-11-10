import { describe, it, expect } from 'vitest';
import { PlayerFireResolver, type PlayerFireResolverDeps } from './PlayerFireResolver.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { resolveSlotMounts } from '../../shared-types/shipKinds/slots.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import type { ShipState } from './schema/SectorState.js';
import type { Client } from 'colyseus';

/**
 * PR 1d slice 4 — a capital's turrets fire independently: each on its OWN
 * reload, as soon as it bears on its target. A turret that comes on target
 * just after a sister turret fired must not wait out a whole group reload.
 * Non-capital groups still fire as one trigger (PlayerFireResolver.groupCooldown).
 */
function harness(kindId = 'destroyer'): {
  fire: (tick: number, shot: string) => void;
  bearing: Set<string>;
  fired: string[];
  acks: Array<{ shot: string; rejected: boolean }>;
  ship: ShipState;
} {
  const kind = getShipKind(kindId);
  const main = resolveSlotMounts(kind, 'main');
  const ship = { kind: kindId, alive: true, energy: 10_000, statAlloc: {}, mounts: [] } as unknown as ShipState;
  const acks: Array<{ shot: string; rejected: boolean }> = [];
  const fired: string[] = [];
  const bearing = new Set<string>();
  let now = 100;
  const deps: PlayerFireResolverDeps = {
    sabF32: new Float32Array(0),
    serverTick: () => now,
    sessionToPlayer: new Map([['sess', 'p1']]),
    getActiveShip: (pid) => (pid === 'p1' ? ship : undefined),
    lastFireClientTick: new Map(),
    fireAllowed: () => true,
    mountBearsOnLock: (_p, mountId) => bearing.has(mountId),
    snapshotRing: { getPoseAt: () => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0 }) },
    shipPoseCache: new Map([['p1', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as never]]),
    playerToSlot: new Map<string, number>(),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    swarmRegistry: { get: () => null, all: () => [] },
    playerMountAngles: new Map(),
    resolveSlotMounts: (k: ShipKind, slotId?: string) => resolveSlotMounts(k, slotId),
    resolveInstanceMounts: () => kind.mounts ?? [],
    resolveInstanceFireMounts: () => main,
    mountWorldOrigin: (x, y) => ({ x, y }),
    playerHitscanDist: () => null,
    spawnServerProjectile: () => {},
    spawnServerMissile: () => null,
    applyDamage: () => {},
    broadcast: () => {},
    serverLogEvent: (tag, data) => { if (tag === 'fire_received') fired.push(String(data.mountId)); },
    logger: { warn: () => {}, info: () => {} } as never,
  };
  const resolver = new PlayerFireResolver(deps);
  const client = {
    sessionId: 'sess',
    send: (_t: string, m: { clientShotId: string; rejected?: boolean }) =>
      acks.push({ shot: m.clientShotId, rejected: m.rejected === true }),
  } as unknown as Client;
  const fire = (tick: number, shot: string): void => {
    now = tick;
    resolver.resolve(client, { type: 'fire', tick, clientShotId: shot, weapon: 'hitscan', dirAngle: 0, slotId: 'main' });
  };
  return { fire, bearing, fired, acks, ship };
}

const rejected = (acks: Array<{ shot: string; rejected: boolean }>, shot: string): boolean =>
  acks.some((a) => a.shot === shot && a.rejected);

describe('PlayerFireResolver — capital turrets fire on their own reload', () => {
  const cd = getWeapon(getShipKind('destroyer').mounts!.find((m) => m.id === 'main-1')!.weaponId).cooldownTicks;

  it('a reloaded turret that comes on target fires straight after a sister turret', () => {
    expect(cd).toBeGreaterThan(5);
    const h = harness();
    h.bearing.add('main-1');
    h.fire(100, 'a');
    expect(h.fired).toEqual(['main-1']);
    h.bearing.add('main-2'); // main-2 trains on a moment later
    h.fire(105, 'b');
    expect(rejected(h.acks, 'b')).toBe(false);
    expect(h.fired).toEqual(['main-1', 'main-2']); // main-1 is still reloading
  });

  it('a turret still reloading does not fire again early', () => {
    const h = harness();
    h.bearing.add('main-1');
    h.fire(100, 'a');
    h.fire(100 + cd - 1, 'b');
    expect(rejected(h.acks, 'b')).toBe(true);
    expect(h.fired).toEqual(['main-1']);
    h.fire(100 + cd, 'c');
    expect(rejected(h.acks, 'c')).toBe(false);
    expect(h.fired).toEqual(['main-1', 'main-1']);
  });

  it('a partial salvo costs its share of the group energy', () => {
    const h = harness();
    const before = h.ship.energy;
    h.bearing.add('main-1');
    h.fire(100, 'a');
    const one = before - h.ship.energy;
    for (const m of ['main-2', 'main-3', 'main-4', 'main-5']) h.bearing.add(m);
    const mid = h.ship.energy;
    h.fire(101, 'b');
    expect(mid - h.ship.energy).toBeCloseTo(one * 4, 6);
  });
});

describe('PlayerFireResolver — a slow gun fires its first shot at once', () => {
  // The "never fired" reload sentinel was -999 ticks. A 16" reloads in 1,800
  // ticks, so a battleship's first salvo was refused until server tick 801
  // (~13 s into a fresh room), locked and on target or not.
  it('a battleship 16" turret fires as soon as it bears, early in a fresh room', () => {
    const cd16 = getWeapon(getShipKind('battleship').mounts!.find((m) => m.id === 'main-1')!.weaponId).cooldownTicks;
    expect(cd16).toBeGreaterThan(1_000);
    const h = harness('battleship');
    h.bearing.add('main-1');
    h.fire(100, 'first');
    expect(rejected(h.acks, 'first')).toBe(false);
    expect(h.fired).toEqual(['main-1']);
    // …and then reloads as usual.
    h.fire(101, 'again');
    expect(rejected(h.acks, 'again')).toBe(true);
  });
});
