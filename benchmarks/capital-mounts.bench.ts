/**
 * Capital turret tick cost (plan prancy-squishing-donut Phase 3): the drone
 * mount pass with N hostile battleships (each ~13 mounts under turret fire
 * control: per-mount lead aim, slew, reload and fire gating) against 4 pilots.
 * The real `WeaponMountTicker.tickDrone`, with a fake room around it.
 *
 * Budget lives in src/server/CLAUDE.md (Thresholds → capital turret tick).
 */
import { bench, describe } from 'vitest';
import { WeaponMountTicker, type SwarmRecord } from '../src/server/rooms/WeaponMountTicker.js';
import { getShipKind } from '../src/shared-types/shipKinds.js';
import {
  SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase,
} from '../src/shared-types/sabLayout.js';
import type { ShipState } from '../src/server/rooms/schema/SectorState.js';

function ticker(capitals: number): { t: WeaponMountTicker; fired: { n: number } } {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const recs: SwarmRecord[] = [];
  for (let i = 0; i < capitals; i++) {
    const slot = 10 + i;
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = (i % 4) * 3000;
    sab[b + SLOT_Y_OFF] = Math.floor(i / 4) * 7000;
    sab[b + SLOT_ANGLE_OFF] = 0;
    recs.push({ id: `cap-${i}`, slot, kind: 1, shipKind: 'battleship' });
  }
  const players = new Map<string, number>();
  const poses = new Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>();
  for (let p = 0; p < 4; p++) {
    players.set(`p${p}`, p);
    poses.set(`p${p}`, { x: 4500 + p * 400, y: 2000, vx: 60, vy: -20, angle: 0 });
  }
  const hostile = { hostileTo: new Set(players.keys()) };
  const ship = { alive: true, kind: 'fighter' } as unknown as ShipState;
  let tick = 0;
  const fired = { n: 0 };
  const t = new WeaponMountTicker({
    sabF32: sab,
    playerToSlot: players,
    swarmRegistry: { all: () => recs, size: () => recs.length },
    shipPoseCache: poses,
    getActiveShip: () => ship,
    aiController: { getBehaviour: () => hostile },
    swarmHealth: () => new Map(),
    resolveSlotMounts: (kind) => kind.mounts,
    resolveInstanceMounts: () => getShipKind('fighter').mounts,
    resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
    currentTick: () => tick++,
    fireDroneMount: () => { fired.n++; },
  });
  return { t, fired };
}

describe('capital turret tick (WeaponMountTicker.tickDrone)', () => {
  for (const n of [1, 4, 8]) {
    const { t } = ticker(n);
    bench(`${n} battleship(s) × 4 pilots`, () => {
      t.tickDrone();
    });
  }
});
