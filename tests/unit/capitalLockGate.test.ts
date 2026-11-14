/**
 * Lock-to-fire for NPC capitals (PR 1d slice 2): every capital turret picks
 * its own pilot target, and fires at it only once the capital holds a
 * COMPLETED lock on THAT pilot. Two turrets on two pilots need two locks.
 * Drives the REAL WeaponMountTicker (fake room, as capitalFireCadence) and the
 * REAL NpcLockSubsystem.
 */
import { describe, expect, it } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { NpcLockSubsystem, type NpcPose } from '../../src/server/rooms/NpcLockSubsystem';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

/** A battleship at the origin, bow +y, with a slow pilot abeam on each side, 1,200 u out. */
function rig(locked: Set<string>) {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const b = slotBase(10);
  sab[b + SLOT_X_OFF] = 0;
  sab[b + SLOT_Y_OFF] = 0;
  sab[b + SLOT_ANGLE_OFF] = 0;
  const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
  const players = new Map([['p1', 0], ['p2', 1]]);
  const poses = new Map([
    ['p1', { x: 1200, y: 0, vx: 0, vy: 10, angle: 0 }],
    ['p2', { x: -1200, y: 0, vx: 0, vy: 10, angle: 0 }],
  ]);
  const ship = { alive: true, isActive: true, kind: 'battleship' } as unknown as ShipState;
  let tick = 0;
  const fired: string[] = []; // target id per shot
  const t: WeaponMountTicker = new WeaponMountTicker({
    sabF32: sab,
    playerToSlot: players,
    swarmRegistry: { all: () => recs, size: () => 1 },
    shipPoseCache: poses,
    getActiveShip: () => ship,
    aiController: { getBehaviour: () => ({ hostileTo: new Set(['p1', 'p2']) }) },
    swarmHealth: () => new Map(),
    resolveSlotMounts: (k) => k.mounts,
    resolveInstanceMounts: () => getShipKind('fighter').mounts,
    resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
    currentTick: () => tick,
    fireBlocked: (id, targetId) => !locked.has(`${id}|${targetId}`),
    fireDroneMount: (id, i) => { fired.push(t.droneMountTargetIds.get(id)![i]!); },
  });
  const run = (ticks: number) => {
    const end = tick + ticks;
    for (; tick < end; tick++) {
      for (const p of poses.values()) p.y += 10 / 60;
      t.tickDrone();
    }
  };
  return { t, fired, run };
}

describe('NPC capital turrets fire only with a completed lock on their own target', () => {
  it('no lock: turrets train on their pilots but never fire', () => {
    const { t, fired, run } = rig(new Set());
    const seen = new Set<string>();
    for (let k = 0; k < 30; k++) {
      run(50);
      for (const id of t.droneMountTargetIds.get('bs')!) if (id) seen.add(id);
    }
    expect([...seen].sort()).toEqual(['p1', 'p2']); // turrets did pick both pilots
    expect(fired).toEqual([]);
  });

  it('two turrets on two pilots each need their own lock', () => {
    const locked = new Set<string>();
    const { fired, run } = rig(locked);
    run(600);
    expect(fired).toEqual([]);
    locked.add('bs|p1'); // lock on p1 completes
    run(1500);
    expect(fired.filter((id) => id === 'p1').length).toBeGreaterThan(0);
    expect(fired.filter((id) => id === 'p2')).toEqual([]); // p1's lock doesn't license p2
    locked.add('bs|p2');
    const before = fired.length;
    run(1500);
    expect(fired.slice(before).filter((id) => id === 'p2').length).toBeGreaterThan(0);
  });
});

describe('NpcLockSubsystem — a capital locks pilots its turrets can engage', () => {
  function lockRig(capitalKind: string, pilots: Record<string, { x: number; y: number; kind: string }>) {
    const npc = { x: 0, y: 0, kind: capitalKind };
    const write = (b: { x: number; y: number; kind: string }, out: NpcPose) => {
      out.x = b.x; out.y = b.y; out.vx = 0; out.vy = 0; return getShipKind(b.kind);
    };
    return new NpcLockSubsystem({
      pilots: () => Object.keys(pilots),
      pilotPose: (id, out) => (pilots[id] ? write(pilots[id]!, out) : null),
      forEachHostileNpc: (_pid, visit) => visit('bs', 1),
      npcPose: (_id, out) => write(npc, out),
    });
  }

  it('a battleship locks a fighter (AA reach) and a capital (main battery reach) at once', () => {
    const s = lockRig('battleship', {
      f: { x: 800, y: 0, kind: 'fighter' },
      c: { x: -3000, y: 0, kind: 'battleship' },
    });
    for (let i = 0; i < 200 && !(s.isLocked('bs', 'f') && s.isLocked('bs', 'c')); i++) s.step();
    // Its 16" profile alone locks a fighter only slowly (~38 s at 5 km; owner
    // 2026-11-13: same rule as a player battleship), so within 20 s
    // the AA mounts' profile must count.
    expect(s.isLocked('bs', 'f')).toBe(true);
    expect(s.isLocked('bs', 'c')).toBe(true);
    expect(s.fireBlocked('bs', 'f')).toBe(false);
    expect(s.fireBlocked('bs', 'c')).toBe(false);
  });
});

describe('testMode lockTimeCapS caps NPC locks (drones and capitals on pilots)', () => {
  const rig = (cap: number | undefined, npcX = 5000) => {
    const write = (x: number, kind: string, out: NpcPose) => { out.x = x; out.y = 0; out.vx = 0; out.vy = 0; return getShipKind(kind); };
    return new NpcLockSubsystem({
      pilots: () => ['f'],
      pilotPose: (_id, out) => write(0, 'fighter', out),
      forEachHostileNpc: (_pid, visit) => visit('bs', 1),
      npcPose: (_id, out) => write(npcX, 'battleship', out), // 5,000 u: only the 16" reaches
      lockTimeCapS: () => cap,
    });
  };
  it('cap 0: a slow 16" lock (~38 s, owner 2026-11-13: slow, never impossible) completes on the first step', () => {
    const none = rig(undefined);
    for (let i = 0; i < 200; i++) none.step();
    expect(none.isLocked('bs', 'f')).toBe(false);
    const zero = rig(0);
    zero.step();
    expect(zero.isLocked('bs', 'f')).toBe(true);
  });
  it('cap N: the lock still takes N seconds of 0.1 s lock steps (shortened, not skipped)', () => {
    const s = rig(1);
    for (let i = 0; i < 8; i++) s.step();
    expect(s.isLocked('bs', 'f')).toBe(false);
    for (let i = 0; i < 4; i++) s.step();
    expect(s.isLocked('bs', 'f')).toBe(true);
  });
  it("out of every gun's reach the cap does nothing", () => {
    const s = rig(0, 100_000);
    for (let i = 0; i < 20; i++) s.step();
    expect(s.isLocked('bs', 'f')).toBe(false);
  });
});

describe('NpcLockSubsystem — testMode instantLock completes NPC locks on that pilot', () => {
  const rig = (instant: boolean) => {
    const write = (x: number, kind: string, out: NpcPose) => { out.x = x; out.y = 0; out.vx = 0; out.vy = 0; return getShipKind(kind); };
    return new NpcLockSubsystem({
      pilots: () => ['f'],
      pilotPose: (_id, out) => write(0, 'fighter', out),
      forEachHostileNpc: (_pid, visit) => visit('bs', 1),
      npcPose: (_id, out) => write(5000, 'battleship', out), // only the 16" reaches
      instantLock: () => instant,
    });
  };
  it('a 16" lock on a fighter takes ~38 s normally, but completes at once under instantLock', () => {
    const normal = rig(false);
    for (let i = 0; i < 200; i++) normal.step();
    expect(normal.isLocked('bs', 'f')).toBe(false);
    const instant = rig(true);
    instant.step();
    expect(instant.isLocked('bs', 'f')).toBe(true);
  });
});

/** The structure, abeam to starboard: AA and 5" mounts bear on it within a
 *  fraction of a second, so only the lock holds their fire. */
const ABEAM = { x: 1500, y: 0 };

describe('NPC capital turrets engage hostile structures under their own lock', () => {
  /** A battleship at the origin and one structure (radius 300) abeam, 1,500 u out. */
  function structRig(hostile: boolean, at: { x: number; y: number } = ABEAM, lockTimeCapS?: number) {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(10);
    sab[b + SLOT_X_OFF] = 0;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0;
    const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
    const structs = [{ id: 'gun', x: at.x, y: at.y, radius: 300 }];
    let tick = 0;
    const fired: { tick: number; target: string }[] = [];
    const t: WeaponMountTicker = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: new Map(),
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: new Map(),
      getActiveShip: () => undefined,
      aiController: { getBehaviour: () => ({ hostileTo: new Set(hostile ? ['gun'] : []) }) },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => getShipKind('fighter').mounts,
      resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
      currentTick: () => tick,
      fireBlocked: () => true, // no pilot lock: only a structure lock can license a shot
      hostileStructures: () => structs,
      lockTimeCapS: () => lockTimeCapS,
      fireDroneMount: (id, i) => { fired.push({ tick, target: t.droneMountTargetIds.get(id)![i]! }); },
    });
    const run = (ticks: number) => { const end = tick + ticks; for (; tick < end; tick++) t.tickDrone(); };
    return { t, fired, run };
  }

  it('turrets train on a hostile structure and fire only once their lock completes', () => {
    const { fired, run } = structRig(true);
    run(60 * 40);
    expect(fired.length).toBeGreaterThan(0);
    expect(new Set(fired.map((f) => f.target))).toEqual(new Set(['gun']));
    // The fastest lock possible is baseSeconds / capital sensor (~1.8 s): no
    // shot comes before it, though the AA and 5" mounts bear within ~0.2 s
    // (without the lock gate the first shot comes at tick ~11).
    expect(fired[0]!.tick).toBeGreaterThanOrEqual(Math.floor((1.5 / 0.85) * 60));
  });

  it('testMode lockTimeCapS 0: the first turret on target fires without the ~1.8 s lock wait', () => {
    const { fired, run } = structRig(true, ABEAM, 0);
    run(60 * 5);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]!.tick).toBeLessThan(Math.floor((1.5 / 0.85) * 60)); // under the uncapped minimum
  });

  it('a structure the capital is not hostile to is never a target', () => {
    const { t, fired, run } = structRig(false);
    run(60 * 20);
    expect(fired).toEqual([]);
    expect((t.droneMountTargetIds.get('bs') ?? []).every((x) => x === null)).toBe(true);
  });
});
