/**
 * NPC line of fire for capital turrets (friendly fire slice 2). A capital's
 * turret holds fire while its own escort sits on that turret's line to the
 * target; a turret whose line is clear (the far end of the hull) fires.
 * Drives the REAL WeaponMountTicker (fake room, as capitalLockGate) through
 * the REAL LineOfFireGate, with the room's friendly rule reduced to "the
 * escort is friendly".
 */
import { describe, expect, it } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { LineOfFireGate } from '../../src/server/rooms/LineOfFireGate';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { rayHitsSphere } from '../../src/core/combat/Weapons';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

type Rec = SwarmRecord & { radius: number };

/** A battleship at the origin, bow +y; a slow pilot 1,200 u off the starboard
 *  beam. `escortAt` puts a 40 u escort there (null: none). */
function rig(escortAt: { x: number; y: number } | null) {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const put = (slot: number, x: number, y: number) => {
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y; sab[b + SLOT_ANGLE_OFF] = 0;
  };
  put(10, 0, 0);
  const recs: Rec[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship', radius: getShipKind('battleship').radius }];
  if (escortAt) { put(11, escortAt.x, escortAt.y); recs.push({ id: 'escort', slot: 11, kind: 1, shipKind: 'fighter', radius: 40 }); }
  const gate = new LineOfFireGate<Rec>({
    registry: { all: () => recs },
    sabF32: sab,
    tick: () => tick,
    rayHit: (rec, fx, fy, dx, dy, max, cx, cy) => rayHitsSphere(fx, fy, dx, dy, max, cx, cy, rec.radius),
  });
  const friendly = (r: Rec) => r.id === 'escort';
  const poses = new Map([['p1', { x: 1200, y: 0, vx: 0, vy: 0, angle: 0 }]]);
  const ship = { alive: true, isActive: true, kind: 'fighter' } as unknown as ShipState;
  let tick = 0;
  const fired: number[] = []; // mount index per shot
  const t: WeaponMountTicker = new WeaponMountTicker({
    sabF32: sab,
    playerToSlot: new Map([['p1', 0]]),
    swarmRegistry: { all: () => recs.slice(0, 1), size: () => 1 },
    shipPoseCache: poses,
    getActiveShip: () => ship,
    aiController: { getBehaviour: () => ({ hostileTo: new Set(['p1']) }) },
    swarmHealth: () => new Map(),
    resolveSlotMounts: (k) => k.mounts,
    resolveInstanceMounts: () => getShipKind('fighter').mounts,
    resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
    currentTick: () => tick,
    fireBlocked: () => false,
    fireDroneMount: (_id, i) => { fired.push(i); },
    lineOfFireBlocked: (id, targetId, fx, fy, dx, dy, dist) => gate.blocked(fx, fy, dx, dy, dist, id, targetId, friendly),
  });
  const run = (ticks: number) => { const end = tick + ticks; for (; tick < end; tick++) t.tickDrone(); };
  const mountIdx = (id: string) => getShipKind('battleship').mounts.findIndex((m) => m.id === id);
  return { fired, run, gate, mountIdx };
}

describe('capital turrets hold fire through their own escort', () => {
  it('control: with no escort, the forward and aft starboard 5" guns both fire', () => {
    const { fired, run, mountIdx } = rig(null);
    run(1800);
    expect(fired).toContain(mountIdx('sec-s1'));
    expect(fired).toContain(mountIdx('sec-s5'));
  });

  it('the turret with its escort in the line holds; a turret on the far end fires', () => {
    // The escort sits halfway along sec-s1's line to the pilot (1200, 0);
    // sec-s5 is at the far end of the hull, its line well clear. Read from
    // the catalogue so it holds at any ship scale (#18).
    const s1 = getShipKind('battleship').mounts.find((m) => m.id === 'sec-s1')!;
    const { fired, run, gate, mountIdx } = rig({ x: (s1.localX + 1200) / 2, y: s1.localY / 2 });
    run(1800);
    expect(fired, 'the blocked turret fired through its escort').not.toContain(mountIdx('sec-s1'));
    expect(fired, 'the far turret fired').toContain(mountIdx('sec-s5'));
    expect(gate.checks).toBeGreaterThan(0);
  });
});
