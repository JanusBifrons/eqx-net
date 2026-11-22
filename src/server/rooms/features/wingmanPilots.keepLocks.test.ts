/**
 * Capital S2 — an AI-flown hull keeps the locks it holds (owner rule
 * 2026-11-22): a pilot's locks, moved to the hull when they switch to Command
 * view, stay until the target dies or leaves lock range; only an empty group
 * takes the AI pilot's target; an attack order retargets every group.
 */
import { describe, expect, it } from 'vitest';
import { WingmanPilots, type WingmanPilotsHost } from './wingmanPilots.js';
import type { WireGroup } from '../LockSubsystem.js';

const HULL = 'hull-1';

/** In-memory stand-in for the wingman `LockSubsystem` wire (groups A and B). */
function fakeLocks() {
  const groups = new Map<string, WireGroup[]>();
  return {
    groups,
    wireFor: (id: string) => groups.get(id),
    ensureGroups: (id: string) => {
      if (!groups.has(id)) groups.set(id, [{ id: 'A', m: 1, l: [] }, { id: 'B', m: 1, l: [] }]);
      return groups.get(id);
    },
    cancelLock: (id: string, gid: string) => { groups.get(id)!.find((g) => g.id === gid)!.l.length = 0; },
    requestLock: (id: string, gid: string, key: string) => { groups.get(id)!.find((g) => g.id === gid)!.l.push({ t: key, s: 0, p: 0 }); return true; },
  };
}

function setup() {
  const locks = fakeLocks();
  const orders = { mode: 'defend', stance: 'defensive', order: null as null | { kind: 'attack'; targetId: string } };
  const brain = { target: null as string | null, getTargetId(): string | null { return this.target; } };
  const alive = new Map<string, boolean>([[HULL, true], ['tA', true], ['tB', true], ['tC', true]]);
  const slots = new Map<string, number>([[HULL, 0], ['tA', 1], ['tB', 2], ['tC', 3]]);
  const host = {
    state: () => ({ ships: { get: (id: string) => (alive.has(id) ? { alive: alive.get(id), playerId: id === HULL ? 'owner' : 'x', kind: 0 } : undefined) } }),
    fleet: {
      size: 1, idAt: () => HULL, ordersAt: () => orders, ownerAt: () => 'owner', squadFollowOf: () => null,
    },
    lingeringSlots: slots,
    lingeringPoseCache: new Map([[HULL, { x: 0, y: 0 }]]),
    playerToActiveShipInstance: new Map(),
    playerToSlot: () => new Map(),
    swarmRegistry: { get: () => undefined, getByEntityId: () => undefined },
    sabF32: () => new Float32Array(64 * 16),
    serverTick: () => 0,
    aiController: () => ({ getBehaviour: () => brain }),
    wingmanLocks: () => locks,
    getActiveShip: () => undefined,
    resolveActiveShipKey: () => undefined,
    fleetStatusSoonFor: () => {},
  } as unknown as WingmanPilotsHost;
  const pilots = new WingmanPilots(host);
  const keys = (): string[][] => locks.groups.get(HULL)!.map((g) => g.l.map((l) => l.t));
  /** The pilot's locks, moved onto the hull at hand-over (`shipKeyMoved`). */
  const handOver = (a: string | null, b: string | null): void => {
    locks.ensureGroups(HULL);
    if (a !== null) locks.requestLock(HULL, 'A', a);
    if (b !== null) locks.requestLock(HULL, 'B', b);
  };
  return { pilots, locks, orders, brain, slots, keys, handOver };
}

describe('tickWingmanTargets keeps held locks (capital S2)', () => {
  it('a handed-over lock survives ticks while the fresh AI pilot has no target', () => {
    const t = setup();
    t.handOver('p:tA', null);
    for (let i = 0; i < 5; i++) t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual([['p:tA'], []]);
  });

  it('with an AI target, a held group keeps its lock and an empty group takes the target', () => {
    const t = setup();
    t.handOver('p:tA', null);
    t.brain.target = 'tB';
    t.pilots.tickWingmanTargets();
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual([['p:tA'], ['p:tB']]);
  });

  it('an attack order retargets every group', () => {
    const t = setup();
    t.handOver('p:tA', 'p:tB');
    t.orders.order = { kind: 'attack', targetId: 'tC' };
    t.brain.target = 'tC';
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual([['p:tC'], ['p:tC']]);
  });

  it('once the lock step drops a dead target, the group takes the AI target', () => {
    const t = setup();
    t.handOver('p:tA', null);
    t.brain.target = 'tB';
    t.pilots.tickWingmanTargets();
    // tA dies: the lock step (`LockSubsystem.stepGroup`) drops its lock.
    t.locks.cancelLock(HULL, 'A');
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual([['p:tB'], ['p:tB']]);
  });

  it('a draining (released) lock does not count as held', () => {
    const t = setup();
    t.handOver('p:tA', null);
    t.locks.groups.get(HULL)![0]!.l[0]!.r = 1;
    t.brain.target = 'tB';
    t.pilots.tickWingmanTargets();
    expect(t.keys()[0]).toEqual(['p:tB']);
  });

  it('hold fire with no order still drops every lock', () => {
    const t = setup();
    t.handOver('p:tA', 'p:tB');
    t.orders.stance = 'holdFire';
    t.brain.target = 'tC';
    t.pilots.tickWingmanTargets();
    expect(t.keys()).toEqual([[], []]);
  });
});
