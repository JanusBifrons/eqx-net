/**
 * The client's per-mount lock pick (fire control): which of its group's
 * LOCKED targets one mount aims and fires at, by the shared
 * `pickTurretLock` with the wire locks' salvage bits (`f`: `LOCK_SALVAGE` |
 * `LOCK_HAULABLE`), the same inputs as the server's
 * `LockSubsystem.aimKeyFor` (#15). `TURRET_NO_LOCK` (a mining laser whose
 * locks are all haulable pieces) means no aim, so no fire. Split out of
 * ColyseusClient.ts (god-file cap). Allocation-free (#14): class scratch.
 */
import { pickTurretLock, TURRET_NO_LOCK, TURRET_PICK_MAX } from '@core/combat/turretLockPick';
import { newFireTargetShape, type FireTargetShape } from '@core/combat/fireControlBearing';
import type { MountRangeTarget } from '@core/combat/mountReach';
import type { WeaponMount } from '@shared-types/shipKinds';

/** One lock as the own-ship snapshot carries it (`WireLock`). */
export interface FcWireLock { readonly t: string; readonly s: number; readonly f?: number }

/** A mount's fire-control definition: its group's mounts in slot order, its
 *  place there (the pick ordinal) and its weapon reach. */
export interface FcMountDef { mount: WeaponMount; ordinal: number; reach: number; group: ReadonlyArray<WeaponMount> }

type RangeShapeOut = { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] };

/** Lock stage code of a completed lock (`LOCK_STAGE_CODE.locked`). */
const LOCKED = 2;

/** True when the group's locks need the per-mount pick: several LOCKED
 *  targets, or a LOCKED one with salvage bits (a laser may skip it). */
export function fcNeedsPick(locks: ReadonlyArray<FcWireLock>): boolean {
  let n = 0;
  for (const l of locks) {
    if (l.s !== LOCKED) continue;
    if ((l.f ?? 0) !== 0 || ++n > 1) return true;
  }
  return false;
}

export class FcMountPicker {
  private readonly x = new Float64Array(TURRET_PICK_MAX);
  private readonly y = new Float64Array(TURRET_PICK_MAX);
  private readonly flags = new Uint8Array(TURRET_PICK_MAX);
  private readonly shapes: RangeShapeOut[] =
    Array.from({ length: TURRET_PICK_MAX }, () => ({ kindId: null, angle: 0, shieldUp: false, radius: 0 }));
  private readonly keys: string[] = [];
  private readonly pose: FireTargetShape = newFireTargetShape();

  /** `targetPose` / `targetShape`: the client's mirror lookups of a lock key
   *  (the fields the server's `resolveLockTarget` fills). */
  constructor(
    private readonly targetPose: (key: string, out: FireTargetShape) => boolean,
    private readonly targetShape: (key: string, out: RangeShapeOut) => void,
  ) {}

  /** The lock key mount `def` aims at from ship pose (sx, sy, sAngle), or
   *  null for no aim; `fallback` when the group has no LOCKED target. */
  pick(locks: ReadonlyArray<FcWireLock>, def: FcMountDef, sx: number, sy: number, sAngle: number, fallback: string | null): string | null {
    const keys = this.keys;
    keys.length = 0;
    // Every LOCKED lock, seen or not, as the server's `pickLocked` (#15): the
    // salvage decision and piece count read the wire bits, never mirror
    // presence. A lock outside the mirror gets a NaN pose (never engageable).
    for (const l of locks) {
      if (l.s !== LOCKED || keys.length >= TURRET_PICK_MAX) continue;
      const sh = this.shapes[keys.length]!;
      if (this.targetPose(l.t, this.pose)) {
        this.x[keys.length] = this.pose.x;
        this.y[keys.length] = this.pose.y;
        this.targetShape(l.t, sh);
      } else {
        this.x[keys.length] = NaN;
        this.y[keys.length] = NaN;
        sh.kindId = null; sh.angle = 0; sh.shieldUp = false; sh.radius = 0;
      }
      this.flags[keys.length] = l.f ?? 0;
      keys.push(l.t);
    }
    if (keys.length === 0) return fallback;
    const m = def.mount;
    const cosA = Math.cos(sAngle);
    const sinA = Math.sin(sAngle);
    const mx = sx + (m.localX * cosA - m.localY * sinA);
    const my = sy + (m.localX * sinA + m.localY * cosA);
    const i = pickTurretLock(m, sAngle, mx, my, def.reach, def.ordinal, keys.length, this.x, this.y, this.shapes, this.flags, def.group);
    return i === TURRET_NO_LOCK ? null : keys[i]!;
  }
}
