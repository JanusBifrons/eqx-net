/**
 * Charge-up on capital turrets (plan step 6): the per-mount charge store
 * (`WeaponMountTicker.charges`) driven by the REAL `tickCapitalMounts` (fake
 * room, as capitalFireCadence.test.ts). No catalogue weapon charges on a
 * capital yet (the railgun comes later), so the 5" gun is given a charge for
 * the test and restored after.
 *
 *  - 'when-bearing': a loaded, locked, bearing turret charges for
 *    `chargeTicks`, then fires; a charge that completes while the gun can't
 *    bear is held and fires the moment it bears again.
 *  - 'locked-direction': fires the moment the charge completes, bearing or not.
 *  - A ship that leaves the world (death) drops its charges: nothing fires.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOT_CHARGING, WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { getWeapon, type WeaponDef } from '../../src/core/combat/WeaponCatalogue';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

const CHARGE = 60;
type Mutable = { -readonly [K in keyof WeaponDef]?: WeaponDef[K] };

function rig() {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const b = slotBase(10);
  sab[b + SLOT_X_OFF] = 0;
  sab[b + SLOT_Y_OFF] = 0;
  sab[b + SLOT_ANGLE_OFF] = 0; // bow +y; the target sits abeam to starboard
  const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
  const pose = { x: 3000, y: 0, vx: 0, vy: 0, angle: 0 };
  const ship = { alive: true, isActive: true, kind: 'battleship', shield: 0 } as unknown as ShipState;
  const fires: Array<{ i: number; tick: number }> = [];
  const clock = { tick: 0 };
  const t = new WeaponMountTicker({
    sabF32: sab,
    playerToSlot: new Map([['p', 0]]),
    swarmRegistry: { all: () => recs, size: () => recs.length },
    shipPoseCache: new Map([['p', pose]]),
    getActiveShip: () => ship,
    aiController: { getBehaviour: () => ({ hostileTo: new Set(['p']) }) },
    swarmHealth: () => new Map(),
    resolveSlotMounts: (k) => k.mounts,
    resolveInstanceMounts: () => getShipKind('fighter').mounts,
    resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
    currentTick: () => clock.tick,
    fireDroneMount: (_id, i) => { fires.push({ i, tick: clock.tick }); },
  });
  const step = (): void => { t.tickDrone(); clock.tick++; };
  return { t, pose, recs, fires, clock, step };
}

const S_MOUNTS = getShipKind('battleship').mounts.map((m, i) => (m.weaponId === 'naval_s' ? i : -1)).filter((i) => i >= 0);

describe('capital turret charge-up (one per-mount store)', () => {
  const def = getWeapon('naval_s') as Mutable;
  const saved = { chargeTicks: def.chargeTicks, chargeRelease: def.chargeRelease, chargeTelegraph: def.chargeTelegraph };
  beforeEach(() => {
    def.chargeTicks = CHARGE;
    def.chargeRelease = 'when-bearing';
    def.chargeTelegraph = 'mount-glow';
  });
  afterEach(() => {
    def.chargeTicks = saved.chargeTicks;
    def.chargeRelease = saved.chargeRelease;
    def.chargeTelegraph = saved.chargeTelegraph;
  });

  it('when-bearing: charges for chargeTicks, then fires on bearing; the store carries the mask + start', () => {
    const { t, fires, step, clock } = rig();
    let start = NOT_CHARGING, mount = -1;
    for (let k = 0; k < 3000 && mount < 0; k++) {
      step();
      const starts = t.charges.starts.get('bs');
      if (starts) for (const i of S_MOUNTS) if (starts[i] !== NOT_CHARGING) { mount = i; start = starts[i]!; break; }
    }
    expect(mount, 'no 5" turret ever began a charge').toBeGreaterThanOrEqual(0);
    expect(fires.some((f) => f.i === mount), 'fired before charging').toBe(false);
    expect(t.charges.mask('bs') & (1 << mount)).not.toBe(0);
    expect(t.charges.startTick('bs')).toBeLessThanOrEqual(start);
    while (clock.tick < start + CHARGE + 30) step();
    const first = fires.find((f) => f.i === mount);
    expect(first, 'the charged turret never fired').toBeDefined();
    expect(first!.tick - start).toBe(CHARGE);
    expect(t.charges.starts.get('bs')![mount]).toBe(NOT_CHARGING);
  });

  it('when-bearing: a charge that completes off bearing is held, then fires the moment it bears', () => {
    const { t, pose, fires, step, clock } = rig();
    let start = NOT_CHARGING, mount = -1;
    for (let k = 0; k < 3000 && mount < 0; k++) {
      step();
      const starts = t.charges.starts.get('bs');
      if (starts) for (const i of S_MOUNTS) if (starts[i] !== NOT_CHARGING) { mount = i; start = starts[i]!; break; }
    }
    expect(mount).toBeGreaterThanOrEqual(0);
    // The target jumps to the other beam: a starboard 5" can't bear on it.
    pose.x = -3000;
    while (clock.tick < start + CHARGE * 4) step();
    expect(fires.some((f) => f.i === mount), 'fired without bearing').toBe(false);
    expect(t.charges.starts.get('bs')![mount], 'the completed charge was dropped').toBe(start);
    expect(t.charges.mask('bs') & (1 << mount)).not.toBe(0);
    // Back to starboard: it fires once it bears again, without re-charging.
    pose.x = 3000;
    const back = clock.tick;
    for (let k = 0; k < 3000 && !fires.some((f) => f.i === mount); k++) step();
    const shot = fires.find((f) => f.i === mount);
    expect(shot, 'the held charge never fired').toBeDefined();
    expect(shot!.tick).toBeGreaterThanOrEqual(back);
    expect(t.charges.starts.get('bs')![mount]).toBe(NOT_CHARGING);
  });

  it('locked-direction: fires the moment the charge completes, bearing or not', () => {
    (getWeapon('naval_s') as Mutable).chargeRelease = 'locked-direction';
    const { t, pose, fires, step, clock } = rig();
    let start = NOT_CHARGING, mount = -1;
    for (let k = 0; k < 3000 && mount < 0; k++) {
      step();
      const starts = t.charges.starts.get('bs');
      if (starts) for (const i of S_MOUNTS) if (starts[i] !== NOT_CHARGING) { mount = i; start = starts[i]!; break; }
    }
    expect(mount).toBeGreaterThanOrEqual(0);
    pose.x = -3000; // the target dodges during the wind-up
    while (clock.tick <= start + CHARGE) step();
    const shot = fires.find((f) => f.i === mount);
    expect(shot, 'the charge did not fire on completion').toBeDefined();
    expect(shot!.tick - start).toBe(CHARGE);
  });

  it('a ship that leaves the world drops its charge: it never fires', () => {
    const { t, recs, fires, step, clock } = rig();
    let start = NOT_CHARGING;
    for (let k = 0; k < 3000 && start === NOT_CHARGING; k++) {
      step();
      start = t.charges.startTick('bs');
    }
    expect(start).not.toBe(NOT_CHARGING);
    const before = fires.length;
    // Death: the evictor unregisters the ship and clears its turret state.
    recs.length = 0;
    t.clearDrone('bs');
    expect(t.charges.mask('bs')).toBe(0);
    while (clock.tick < start + CHARGE * 3) step();
    expect(fires.length).toBe(before);
  });
});
