/**
 * The server's per-mount lock pick (fire control): which of its group's
 * LOCKED targets one mount aims and fires at, by the shared `pickTurretLock`
 * with the locks' salvage bits. The client's side is `FcMountPicker`
 * (`client/net/fcMountPick.ts`); both list EVERY LOCKED lock in lock order,
 * a lock they can't place getting a NaN pose (never engageable), so the
 * salvage decision and piece count read the same flags on both sides (#15).
 * Split out of LockSubsystem.ts (god-file cap). Allocation-free (#14): class
 * scratch.
 */
import { pickTurretLock, TURRET_NO_LOCK, TURRET_PICK_MAX } from '../../core/combat/turretLockPick.js';
import { mountWeaponReach, type MountRangeTarget } from '../../core/combat/mountReach.js';
import type { LockEntry } from '../../core/combat/lockState.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import type { LockShooterView, LockTargetView } from './LockSubsystem.js';

type RangeShapeOut = { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] };

export class LockPicker {
  private readonly x = new Float64Array(TURRET_PICK_MAX);
  private readonly y = new Float64Array(TURRET_PICK_MAX);
  private readonly flags = new Uint8Array(TURRET_PICK_MAX);
  private readonly keys: string[] = [];
  /** Per-lock hit shapes for `pickTurretLock`'s hull range gate. */
  private readonly shapes: RangeShapeOut[] =
    Array.from({ length: TURRET_PICK_MAX }, () => ({ kindId: null, angle: 0, shieldUp: false, radius: 0 }));

  /**
   * The lock key mount `mounts[ordinal]` (on a hull at `s`) aims at: null = no
   * aim (`TURRET_NO_LOCK`, a mining laser whose locks are all haulable),
   * undefined = the group has no LOCKED target. `resolve` fills `target`
   * (scratch) for a key, false when it is gone.
   */
  pick(
    resolve: { resolveTarget(playerId: string, key: string, out: LockTargetView): boolean },
    playerId: string, locks: ReadonlyArray<LockEntry>, mounts: ReadonlyArray<WeaponMount>, ordinal: number,
    s: LockShooterView, target: LockTargetView,
  ): string | null | undefined {
    const keys = this.keys;
    keys.length = 0;
    for (const e of locks) {
      if (e.stage !== 'locked' || keys.length >= TURRET_PICK_MAX) continue;
      const n = keys.length;
      this.flags[n] = e.flags;
      const sh = this.shapes[n]!;
      if (resolve.resolveTarget(playerId, e.target, target)) {
        this.x[n] = target.x;
        this.y[n] = target.y;
        sh.kindId = target.ship ? target.kindId : null;
        sh.angle = target.angle;
        sh.shieldUp = target.shieldUp;
        sh.radius = target.ship ? 0 : target.radius;
      } else {
        this.x[n] = NaN;
        this.y[n] = NaN;
        sh.kindId = null; sh.angle = 0; sh.shieldUp = false; sh.radius = 0;
      }
      keys.push(e.target);
    }
    if (keys.length === 0) return undefined;
    const m = mounts[ordinal]!;
    const cosA = Math.cos(s.angle);
    const sinA = Math.sin(s.angle);
    const mx = s.x + (m.localX * cosA - m.localY * sinA);
    const my = s.y + (m.localX * sinA + m.localY * cosA);
    const i = pickTurretLock(m, s.angle, mx, my, mountWeaponReach(m), ordinal, keys.length, this.x, this.y, this.shapes, this.flags, mounts);
    return i === TURRET_NO_LOCK ? null : keys[i]!;
  }
}
