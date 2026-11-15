/**
 * NPC and structure fire range is measured per turret to the target's TRUE
 * hull (owner decision 2026-11-14): a mount fires only when the distance from
 * its world origin to the nearest point of the target's hit shape
 * (`shipHitShape`: hull polygon, or the shield bubble of a non-capital with
 * its shield up; a circle of `radius` for anything else) is within its own
 * weapon reach. Same rule for NPC capitals, NPC drones and structure turrets.
 *
 * Each case drives the REAL fire-control code (WeaponMountTicker,
 * AiFireResolver, StructureMountTicker) with fake rooms, as
 * `capitalLockGate.test.ts` does. Before the fix every gate measured to the
 * target's CENTRE: a battleship alongside another (centres 1.7 km apart, hull
 * ~1.2 km from the AA mounts, AA reach 1,428 u) was never engaged by AA, and a
 * drone with a lock fired from any range its behaviour asked for.
 */
import { describe, expect, it } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { AiFireResolver } from '../../src/server/rooms/AiFireResolver';
import { StructureMountTicker, type TurretTargetView } from '../../src/server/structures/StructureMountTicker';
import { getShipKind, type ShipKind } from '../../src/shared-types/shipKinds';
import { getStructureKind } from '../../src/shared-types/structureKinds';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';
import type { StructureRecord } from '../../src/server/structures/StructureRegistry';
import { mountWeaponReach } from '../../src/core/combat/mountReach';
import { shipHullDistance } from '../../src/core/combat/shipHitShape';
import type { AiEntity } from '../../src/core/contracts/IAiBehaviour';

describe('NPC capital: AA engages a pilot battleship whose hull is alongside', () => {
  /** An NPC battleship at the origin (bow +y) and a pilot battleship abeam to
   *  starboard, parallel, `x` u out, shield down. */
  function rig(x: number) {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(10);
    sab[b + SLOT_X_OFF] = 0;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0;
    const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
    const poses = new Map([['p1', { x, y: 0, vx: 0, vy: 0, angle: 0 }]]);
    const ship = { alive: true, isActive: true, kind: 'battleship', shield: 0 } as unknown as ShipState;
    const kind = getShipKind('battleship');
    let tick = 0;
    const firedMounts: string[] = [];
    const t: WeaponMountTicker = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: new Map([['p1', 0]]),
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: poses,
      getActiveShip: () => ship,
      aiController: { getBehaviour: () => ({ hostileTo: new Set(['p1']) }) },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => kind.mounts,
      resolveInstanceFireMounts: () => kind.mounts,
      currentTick: () => tick,
      fireBlocked: () => false, // locked: only range and bearing gate fire here
      fireDroneMount: (_id, i) => { firedMounts.push(kind.mounts[i]!.id); },
    });
    const run = (ticks: number) => { const end = tick + ticks; for (; tick < end; tick++) t.tickDrone(); };
    return { firedMounts, run };
  }

  it('the geometry: AA mount centre distance past its reach, hull distance inside it', () => {
    const aa = getShipKind('battleship').mounts.find((m) => m.id === 'aa-s1')!;
    const reach = mountWeaponReach(aa);
    expect(Math.hypot(1700 - aa.localX, aa.localY)).toBeGreaterThan(reach);
    expect(shipHullDistance('battleship', false, aa.localX, aa.localY, 1700, 0, 0)).toBeLessThan(reach);
  });

  it('starboard AA fires at the hull alongside (centres 1.7 km apart)', () => {
    const { firedMounts, run } = rig(1700);
    run(60 * 20);
    expect(firedMounts.filter((id) => id.startsWith('aa-s')).length).toBeGreaterThan(0);
  });

  it('AA never fires once the hull is beyond its reach', () => {
    const { firedMounts, run } = rig(4000); // hull ~3.3 km from the nearest AA mount
    run(60 * 20);
    expect(firedMounts.filter((id) => id.startsWith('aa-'))).toEqual([]);
  });
});

describe('NPC drone: no mount fires at a target beyond its reach, even with a lock', () => {
  /** A fighter drone at the origin facing +y, its target pilot fighter
   *  straight ahead `y` u out (shield up), lock completed. */
  function rig(y: number) {
    const fired: number[] = [];
    const kind: ShipKind = getShipKind('fighter');
    const self: AiEntity = { id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0 } as unknown as AiEntity;
    const ship = { alive: true, isActive: true, kind: 'fighter', shield: 100 } as unknown as ShipState;
    const r = new AiFireResolver({
      fireBlocked: () => false,
      lastFireClientTick: new Map(),
      swarmEntitySnapshot: () => self,
      swarmRegistry: { get: () => ({ entityId: 1, shipKind: 'fighter' }) },
      resolveSlotMounts: (k) => k.mounts,
      mountWorldOrigin: (sx, sy) => ({ x: sx, y: sy }),
      droneMountAngles: new Map(),
      playerToSlot: [['p1', 0]],
      getActiveShip: () => ship,
      shipPoseCache: new Map([['p1', { x: 0, y, angle: 0 }]]),
      playerHitscanDist: () => null,
      applyDamage: () => undefined,
      broadcast: () => { fired.push(1); },
      spawnServerProjectile: () => { fired.push(1); },
      spawnServerMissile: () => { fired.push(1); return 1; },
      targetShape: (id, out) => {
        if (id !== 'p1') return false;
        out.x = 0; out.y = y; out.kindId = 'fighter'; out.angle = 0; out.shieldUp = true; out.radius = 0;
        return true;
      },
    });
    return { fired, fire: (tick: number) => r.resolve('d', 0, 1, tick, 'p1'), kind };
  }

  it('fires when the target hull is inside the mount reach', () => {
    const reach = mountWeaponReach(getShipKind('fighter').mounts[0]!);
    const { fired, fire } = rig(reach * 0.5);
    fire(1000);
    expect(fired.length).toBeGreaterThan(0);
  });

  it('holds fire (no cooldown spent) when the target hull is beyond the mount reach', () => {
    const reach = mountWeaponReach(getShipKind('fighter').mounts[0]!);
    const { fired, fire } = rig(reach + 400);
    fire(1000);
    expect(fired).toEqual([]);
  });
});

describe('Structure turret: range is measured to the target hull', () => {
  function setup(target: Omit<TurretTargetView, 'id' | 'entityId' | 'vx' | 'vy' | 'cls' | 'signature'>) {
    const shots: string[] = [];
    const cand: TurretTargetView = { id: 'cap', entityId: 1, vx: 0, vy: 0, cls: 'capital', signature: 2876, ...target };
    const ticker = new StructureMountTicker({
      targets: (_x, _y, _range, _owner, out) => { out[0] = cand; return 1; },
      fire: (_rec, _kind, _i, _mount, _def, _ndx, _ndy, t) => { shots.push(t.id); return true; },
    });
    ticker.setInstantLocks(true);
    const kind = getStructureKind('coastal_barbette_16in');
    const rec = { id: 'g', kind: kind.id, owner: 'npc:red', x: 0, y: 0, rot: 0, level: 1, isConstructed: true } as unknown as StructureRecord;
    let now = 0;
    for (let i = 0; i < 300; i++) {
      now += 100;
      const dt = ticker.beginTick(now, 0.1);
      ticker.tick(rec, kind, kind.mounts!, now, dt);
    }
    return { shots, reach: kind.weaponRange! };
  }

  it('a battleship whose centre is past reach but whose bow is inside it is engaged', () => {
    const reach = getStructureKind('coastal_barbette_16in').weaponRange!;
    // Bow-on toward the barbette (angle π: bow −y), centre reach + 2,000 u up +y.
    const y = reach + 2000;
    expect(shipHullDistance('battleship', false, 0, 0, 0, y, Math.PI)).toBeLessThan(reach);
    const { shots } = setup({ x: 0, y, kindId: 'battleship', angle: Math.PI, shieldUp: false });
    expect(shots.length).toBeGreaterThan(0);
  });

  it('the same battleship broadside on at that range (hull out of reach) is not', () => {
    const reach = getStructureKind('coastal_barbette_16in').weaponRange!;
    const y = reach + 2000;
    expect(shipHullDistance('battleship', false, 0, 0, 0, y, Math.PI / 2)).toBeGreaterThan(reach);
    const { shots } = setup({ x: 0, y, kindId: 'battleship', angle: Math.PI / 2, shieldUp: false });
    expect(shots).toEqual([]);
  });
});
