/**
 * Fleet salvage order, slice 2 — an AI-flown hull with a `salvage` order
 * locks ONLY its salvage groups (mining laser, tractors) on the ordered scrap
 * piece; a gun group keeps the AI pilot brain's pick and the stance. A
 * salvage group's trigger is its (completed) lock; a gun never fires at will.
 * The mining skiff's slots are 'laser' and 'tractor'; 'guns' stands in for a
 * gun group (not a slot of the kind ⇒ not salvage).
 *
 * The skiff's turrets give it turret fire control (every group's trigger is
 * already its lock, the capital rule); the fire tests stub that off to lock
 * the small-ship rule: there, only salvage groups fire without the brain.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/combat/mountReach.js', async (orig) => ({
  ...(await orig<typeof import('../../../core/combat/mountReach.js')>()),
  hasTurretFireControl: () => false,
}));
import { WingmanPilots, type WingmanPilotsHost } from './wingmanPilots.js';
import { WingmanSalvage } from './wingmanSalvage.js';
import type { WireGroup } from '../LockSubsystem.js';
import { SWARM_KIND_DRONE, SWARM_KIND_SCRAP } from '../../../shared-types/swarmWireFormat.js';

const HULL = 'hull-1';
const SCRAP = 'swarm-7';
const SCRAP_KEY = 's:7';
type Order = null | { kind: 'salvage' | 'attack'; targetId: string };

function setup() {
  const groups = new Map<string, WireGroup[]>();
  const locks = {
    groups,
    wireFor: (id: string) => groups.get(id),
    ensureGroups: (id: string) => {
      if (!groups.has(id)) groups.set(id, [{ id: 'laser', m: 1, l: [] }, { id: 'tractor', m: 1, l: [] }, { id: 'guns', m: 1, l: [] }]);
      return groups.get(id);
    },
    cancelLock: (id: string, gid: string) => { groups.get(id)!.find((g) => g.id === gid)!.l.length = 0; },
    requestLock: (id: string, gid: string, key: string) => { groups.get(id)!.find((g) => g.id === gid)!.l.push({ t: key, s: 2, p: 1 }); return true; },
    // Test stand-in for a completed lock (instantLock): every held lock is LOCKED.
    hasLocked: (id: string, gid: string) => (groups.get(id)?.find((g) => g.id === gid)?.l.length ?? 0) > 0,
  };
  const orders = { mode: 'defend', stance: 'defensive', order: null as Order };
  const brain = { target: null as string | null, getTargetId(): string | null { return this.target; }, setKeptLockTarget(): void {} };
  const swarm = new Map<number, { id: string; entityId: number; kind: number; shipKind?: string }>([
    [7, { id: 'scrap-7', entityId: 7, kind: SWARM_KIND_SCRAP, shipKind: 'havok' }],
    [9, { id: 'drone-9', entityId: 9, kind: SWARM_KIND_DRONE }],
  ]);
  const fired: string[] = [];
  const host = {
    state: () => ({ ships: { get: (id: string) => (id === HULL ? { alive: true, playerId: 'owner', kind: 'mining-skiff' } : undefined) } }),
    fleet: { size: 1, idAt: () => HULL, ordersAt: () => orders, ownerAt: () => 'owner', squadFollowOf: () => null },
    lingeringSlots: new Map([[HULL, 0]]),
    lingeringPoseCache: new Map([[HULL, { x: 0, y: 0 }]]),
    playerToActiveShipInstance: new Map(),
    playerToSlot: () => new Map(),
    swarmRegistry: {
      get: (id: string) => [...swarm.values()].find((r) => r.id === id) ?? null,
      getByEntityId: (n: number) => swarm.get(n) ?? null,
    },
    sabF32: () => new Float32Array(64 * 16),
    serverTick: () => 0,
    aiController: () => ({ getBehaviour: () => brain }),
    wingmanLocks: () => locks,
    mountTicker: () => ({ tickHull: () => {} }),
    playerFireResolver: () => ({ fireHull: (_sid: string, _ship: unknown, gid: string) => { fired.push(gid); } }),
    getActiveShip: () => undefined,
    resolveActiveShipKey: () => undefined,
    fleetStatusSoonFor: () => {},
  } as unknown as WingmanPilotsHost;
  const pilots = new WingmanPilots(host);
  const keys = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const g of groups.get(HULL) ?? []) out[g.id] = g.l.map((l) => l.t);
    return out;
  };
  return { pilots, orders, brain, swarm, keys, fired, host };
}

describe('WingmanSalvage', () => {
  it('lock key: only a salvage order on a live scrap / wreck piece', () => {
    const t = setup();
    const s = new WingmanSalvage(t.host);
    expect(s.lockKey(HULL, null)).toBeNull();
    expect(s.lockKey(HULL, { kind: 'attack', targetId: SCRAP })).toBeNull();
    expect(s.lockKey(HULL, { kind: 'salvage', targetId: SCRAP })).toBe(SCRAP_KEY);
    expect(s.lockKey(HULL, { kind: 'salvage', targetId: 'swarm-9' }), 'a drone is not salvage').toBeNull();
    t.swarm.delete(7);
    expect(s.lockKey(HULL, { kind: 'salvage', targetId: SCRAP }), 'the piece is gone').toBeNull();
  });

  it('salvage groups: the mining laser and the tractors, never a gun', () => {
    const s = new WingmanSalvage(setup().host);
    expect(s.isSalvageGroup('mining-skiff', 'laser')).toBe(true);
    expect(s.isSalvageGroup('mining-skiff', 'tractor')).toBe(true);
    expect(s.isSalvageGroup('mining-skiff', 'guns')).toBe(false);
    expect(s.isSalvageGroup('fighter', 'guns')).toBe(false);
  });
});

describe('tickWingmanTargets under a salvage order', () => {
  it('locks only the salvage groups on the piece; the gun group keeps the brain pick', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.brain.target = 'drone-9';
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual({ laser: [SCRAP_KEY], tractor: [SCRAP_KEY], guns: ['s:9'] });
  });

  it('with no brain target, the guns lock nothing (never the scrap)', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual({ laser: [SCRAP_KEY], tractor: [SCRAP_KEY], guns: [] });
  });

  it('a pilot-kept lock on a salvage group gives way to the salvage order', () => {
    const t = setup();
    t.pilots.tickWingmanTargets(); // no target: groups untouched
    t.host.wingmanLocks().ensureGroups(HULL);
    t.host.wingmanLocks().requestLock(HULL, 'laser', 's:9'); // the pilot's lock, handed over
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.pilots.tickWingmanTargets();
    expect(t.keys().laser).toEqual([SCRAP_KEY]);
  });

  it('Hold fire: the guns drop their lock, salvage still locks the piece', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.brain.target = 'drone-9';
    t.pilots.tickWingmanTargets();
    t.orders.stance = 'holdFire';
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual({ laser: [SCRAP_KEY], tractor: [SCRAP_KEY], guns: [] });
  });

  it('without a salvage order, nothing locks the scrap', () => {
    const t = setup();
    t.brain.target = 'scrap-7'; // even if a brain named it, scrap is not a wingman target
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual({});
  });
});

describe('tickWingmanFire under a salvage order', () => {
  it('the salvage groups fire on their lock; the guns hold without the brain trigger', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.brain.target = 'drone-9';
    t.pilots.tickWingmanTargets();
    t.pilots.tickWingmanFire();
    expect(t.fired.sort()).toEqual(['laser', 'tractor']);
  });

  it('the guns fire only on the brain trigger at their target', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.brain.target = 'drone-9';
    t.pilots.tickWingmanTargets();
    t.pilots.hullTrigger.set(HULL, 'drone-9');
    t.pilots.tickWingmanFire();
    expect(t.fired.sort()).toEqual(['guns', 'laser', 'tractor']);
  });

  it('without a salvage order (or once the piece is gone), nothing fires without the trigger', () => {
    const t = setup();
    t.orders.order = { kind: 'salvage', targetId: SCRAP };
    t.pilots.tickWingmanTargets();
    t.swarm.delete(7);
    t.pilots.tickWingmanFire();
    expect(t.fired).toEqual([]);
    t.orders.order = null;
    t.pilots.tickWingmanFire();
    expect(t.fired).toEqual([]);
  });
});
