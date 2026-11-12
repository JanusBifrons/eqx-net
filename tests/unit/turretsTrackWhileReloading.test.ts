/**
 * A turret keeps tracking its target while it reloads (integration probe
 * report, 2026-11-12; the room-level lock is
 * tests/integration/sectorRoom/turretsTrackWhileReloading.test.ts).
 *
 * Drives the REAL WeaponMountTicker (fake room, as capitalFireCadence.test.ts):
 *  - an NPC battleship's 16" turret that has fired stays on the target for the
 *    whole 30 s reload while the target stays hostile;
 *  - a player's turrets stay on their group's lock target tick after tick (the
 *    player aim reads only the lock, never a reload: the per-mount reload lives
 *    in PlayerFireResolver).
 */
import { describe, expect, it } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { getWeapon } from '../../src/core/combat/WeaponCatalogue';
import { wrapPi } from '../../src/core/ai/WeaponMountController';
import { inMountArc } from '../../src/core/combat/mountFireControl';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

const DEG = 180 / Math.PI;

describe('turrets track while reloading', () => {
  it('an NPC capital turret stays on its hostile target through the reload', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(10);
    sab[b + SLOT_X_OFF] = 0;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0; // bow +y; target abeam to starboard
    const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
    const pose = { x: 3000, y: 0, vx: 0, vy: 0, angle: 0 };
    const ship = { alive: true, isActive: true, kind: 'battleship' } as unknown as ShipState;
    const kind = getShipKind('battleship');
    let tick = 0;
    const firedAt = new Map<number, number>();
    const t = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: new Map([['p', 0]]),
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: new Map([['p', pose]]),
      getActiveShip: () => ship,
      aiController: { getBehaviour: () => ({ hostileTo: new Set(['p']) }) },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => getShipKind('fighter').mounts,
      resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
      currentTick: () => tick,
      fireDroneMount: (_id, i) => { if (!firedAt.has(i)) firedAt.set(i, tick); },
    });
    const xl = kind.mounts.map((m, i) => (m.weaponId === 'naval_xl' ? i : -1)).filter((i) => i >= 0);
    const cd = getWeapon('naval_xl').cooldownTicks;
    // Train and fire.
    for (tick = 0; tick < 3000 && !xl.some((i) => firedAt.has(i)); tick++) t.tickDrone();
    const fired = xl.filter((i) => firedAt.has(i));
    expect(fired.length, 'no 16" turret fired').toBeGreaterThan(0);
    // Through the reload, every fired turret stays on the bearing.
    const end = tick + cd - 1;
    for (; tick < end; tick++) {
      t.tickDrone();
      const angles = t.droneMountAngles.get('bs')!;
      for (const i of fired) {
        const m = kind.mounts[i]!;
        const bearing = Math.atan2(-(pose.x - m.localX), pose.y - m.localY);
        const off = Math.abs(wrapPi(m.baseAngle + angles[i]! - bearing)) * DEG;
        expect(off, `${m.id} left its target ${tick - firedAt.get(i)!} ticks into the reload`).toBeLessThan(2);
      }
    }
  });

  it('a player turret stays on its group lock target (aim never reads a reload)', () => {
    const kind = getShipKind('heavy-cruiser');
    const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
    const target = { x: 4000, y: 0 };
    const ship = { alive: true, isActive: true, kind: 'heavy-cruiser' } as unknown as ShipState;
    const t = new WeaponMountTicker({
      sabF32: new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES)),
      playerToSlot: new Map([['p', 0]]),
      swarmRegistry: { all: () => [], size: () => 0 },
      shipPoseCache: new Map([['p', pose]]),
      getActiveShip: () => ship,
      aiController: { getBehaviour: () => undefined },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => kind.mounts,
      resolveInstanceFireMounts: () => kind.mounts,
      aimTargetFor: (_pid, _mount, out) => { out.x = target.x; out.y = target.y; out.vx = 0; out.vy = 0; return true; },
    });
    const bearing = (i: number): number => {
      const m = kind.mounts[i]!;
      return Math.atan2(-(target.x - m.localX), target.y - m.localY);
    };
    const bears = kind.mounts
      .map((m, i) => (m.rotationSpeed > 0 && inMountArc(m, 0, target.x - m.localX, target.y - m.localY) ? i : -1))
      .filter((i) => i >= 0);
    expect(bears.length).toBeGreaterThan(0);
    for (let k = 0; k < 3600; k++) t.tickPlayer(); // train on (≤ 60 s)
    // A main-gun reload's worth of ticks: the aim never drifts home.
    for (let k = 0; k < 1800; k++) {
      t.tickPlayer();
      const angles = t.playerMountAngles.get('p')!;
      for (const i of bears) {
        const off = Math.abs(wrapPi(kind.mounts[i]!.baseAngle + angles[i]! - bearing(i))) * DEG;
        expect(off, `${kind.mounts[i]!.id} drifted off its lock`).toBeLessThan(1);
      }
    }
  });
});
