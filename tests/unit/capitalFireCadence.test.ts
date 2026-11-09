/**
 * Smoke report (2026-11-07, capital-guns-fighter clip): "Why are the main
 * cannons firing like a gattling cannon?!" A 16"/12" turret reloads in
 * 30 s / 22 s (WW2 rates), so over 33 s each main turret may fire at most
 * twice. Drives the REAL WeaponMountTicker (fake room, as the bench) with one
 * battleship and a slow target in main-battery reach.
 */
import { describe, expect, it } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { getWeapon } from '../../src/core/combat/WeaponCatalogue';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

describe('capital fire cadence', () => {
  it('each turret fires no faster than its reload', () => {
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(10);
    sab[b + SLOT_X_OFF] = 0;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0; // bow +y; target abeam to starboard
    const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
    const players = new Map([['p', 0]]);
    const pose = { x: 3000, y: 0, vx: 0, vy: 10, angle: 0 };
    const poses = new Map([['p', pose]]);
    const ship = { alive: true, isActive: true, kind: 'battleship' } as unknown as ShipState;
    let tick = 0;
    const kind = getShipKind('battleship');
    const fires = new Map<number, number[]>();
    const t = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: players,
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: poses,
      getActiveShip: () => ship,
      aiController: { getBehaviour: () => ({ hostileTo: new Set(['p']) }) },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => getShipKind('fighter').mounts,
      resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
      currentTick: () => tick,
      fireDroneMount: (_id, i) => { (fires.get(i) ?? fires.set(i, []).get(i)!).push(tick); },
    });
    for (tick = 0; tick < 2000; tick++) { pose.y += 10 / 60; t.tickDrone(); }
    const rows: string[] = [];
    for (const [i, ticks] of [...fires].sort((a, z) => a[0] - z[0])) {
      const m = kind.mounts[i]!;
      const cd = getWeapon(m.weaponId).cooldownTicks;
      rows.push(`${m.id} ${m.size} ${m.weaponId} x${ticks.length} @ ${ticks.slice(0, 6).join(',')}`);
      for (let k = 1; k < ticks.length; k++) expect(ticks[k]! - ticks[k - 1]!, `${m.id} refired early`).toBeGreaterThanOrEqual(cd);
    }
    console.log(rows.join('\n'));
    expect(fires.size).toBeGreaterThan(0);
  });
});
