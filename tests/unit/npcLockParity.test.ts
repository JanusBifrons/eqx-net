/**
 * NPC lock parity (owner, 2026-11-13): "Ships turning, acceleration, weapons,
 * everything is related to the ship, regardless of pilot." On locks: "Same
 * rule as players — an NPC's heavy gun locks a small fast ship slowly, but
 * always gets there in the end. It's the same ship and the same gun, so it
 * gets the same lock."
 *
 * Before: the player path skipped the `maxSeconds` gate for heavy guns, the
 * NPC path did not, so an NPC battleship's 16" could NEVER lock a fighter
 * (Infinity) while a player battleship's 16" locked it slowly.
 */
import { describe, expect, it } from 'vitest';
import { lockSeconds, type LockInputs } from '../../src/core/combat/lockTime';
import { LOCK_TUNING, sensorFor, signatureFor } from '../../src/shared-types/combat/lockProfile';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { groupGeometry } from '../../src/server/rooms/LockSubsystem';
import { NpcLockSubsystem, type NpcPose } from '../../src/server/rooms/NpcLockSubsystem';
import { WeaponMountTicker, type SwarmRecord } from '../../src/server/rooms/WeaponMountTicker';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF, slotBase } from '../../src/shared-types/sabLayout';
import type { ShipState } from '../../src/server/rooms/schema/SectorState';

const LOCK_DT = 0.1; // one NPC / player lock step (s)
const RANGE = 5000; // only the battleship's 16" reaches a target this far out
const MAX_STEPS = 1000; // 100 s of lock steps: every loop here is bounded

/** A battleship's 16" group on a still fighter `RANGE` u out, exactly as the
 *  PLAYER fire control (`LockSubsystem`) builds its lock inputs. */
function playerBattleship16InchOnFighter(): LockInputs {
  const bs = getShipKind('battleship');
  const xl = (bs.mounts ?? []).filter((m) => m.size === 'XL');
  const g = groupGeometry(xl);
  return {
    refSize: g.refSize, tracking: g.tracking, reach: g.reach, absRange: g.absRange,
    sensor: sensorFor(bs), pilotSpeed: 1, signature: signatureFor(getShipKind('fighter')),
    dx: RANGE, dy: 0, dvx: 0, dvy: 0,
  };
}

function npcRig(cap?: number) {
  const write = (x: number, kind: string, out: NpcPose) => { out.x = x; out.y = 0; out.vx = 0; out.vy = 0; return getShipKind(kind); };
  return new NpcLockSubsystem({
    pilots: () => ['f'],
    pilotPose: (_id, out) => write(0, 'fighter', out),
    forEachHostileNpc: (_pid, visit) => visit('bs', 1),
    npcPose: (_id, out) => write(RANGE, 'battleship', out),
    lockTimeCapS: () => cap,
  });
}

/** Lock steps until the NPC battleship holds a lock on the fighter (cap: `max`). */
function stepsToLock(s: NpcLockSubsystem, max: number): number {
  for (let n = 1; n <= max; n++) {
    s.step();
    if (s.isLocked('bs', 'f')) return n;
  }
  return Infinity;
}

describe('NPC lock parity: same ship, same gun, same target ⇒ same lock time', () => {
  it('a battleship 16" on a fighter: the shared rule is slow (past maxSeconds) but finite', () => {
    const secs = lockSeconds(playerBattleship16InchOnFighter(), LOCK_TUNING);
    expect(Number.isFinite(secs)).toBe(true);
    expect(secs).toBeGreaterThan(LOCK_TUNING.maxSeconds);
  });

  it('the NPC battleship locks the fighter in the player lock time (was: never)', () => {
    const secs = lockSeconds(playerBattleship16InchOnFighter(), LOCK_TUNING);
    expect(Number.isFinite(secs)).toBe(true);
    const want = Math.ceil(secs / LOCK_DT - 1e-9);
    const n = stepsToLock(npcRig(), MAX_STEPS);
    expect(n).toBeGreaterThanOrEqual(want - 1);
    expect(n).toBeLessThanOrEqual(want + 1);
  });

  it('testMode lockTimeCapS still shortens it (test primitive unchanged)', () => {
    expect(stepsToLock(npcRig(1), 20)).toBeLessThanOrEqual(11);
  });
});

describe('an NPC capital eventually locks AND fires on a small pilot only its 16" reaches', () => {
  it('real NpcLockSubsystem + WeaponMountTicker: no shot until the slow lock completes, then shots', () => {
    const locks = npcRig();
    const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
    const b = slotBase(10);
    sab[b + SLOT_X_OFF] = RANGE;
    sab[b + SLOT_Y_OFF] = 0;
    sab[b + SLOT_ANGLE_OFF] = 0;
    const recs: SwarmRecord[] = [{ id: 'bs', slot: 10, kind: 1, shipKind: 'battleship' }];
    const poses = new Map([['f', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }]]);
    const ship = { alive: true, isActive: true, kind: 'fighter' } as unknown as ShipState;
    let tick = 0;
    const fired: string[] = [];
    const t: WeaponMountTicker = new WeaponMountTicker({
      sabF32: sab,
      playerToSlot: new Map([['f', 0]]),
      swarmRegistry: { all: () => recs, size: () => 1 },
      shipPoseCache: poses,
      getActiveShip: () => ship,
      aiController: { getBehaviour: () => ({ hostileTo: new Set(['f']) }) },
      swarmHealth: () => new Map(),
      resolveSlotMounts: (k) => k.mounts,
      resolveInstanceMounts: () => getShipKind('fighter').mounts,
      resolveInstanceFireMounts: () => getShipKind('fighter').mounts,
      currentTick: () => tick,
      fireBlocked: (id, targetId) => locks.fireBlocked(id, targetId),
      fireDroneMount: (id, i) => { fired.push(t.droneMountTargetIds.get(id)![i]!); },
    });
    let lockedAt = -1;
    for (; tick < MAX_STEPS * 6 + 1200; tick++) { // a lock step every 6 ticks
      if (tick % 6 === 0) {
        locks.step();
        if (lockedAt < 0 && locks.isLocked('bs', 'f')) lockedAt = tick;
      }
      t.tickDrone();
      if (lockedAt < 0) expect(fired).toEqual([]);
    }
    expect(lockedAt).toBeGreaterThan(0);
    expect(fired.filter((id) => id === 'f').length).toBeGreaterThan(0);
  });
});
