/**
 * Defence-structure fire control (plan coastal-defences). Every weapon mount on
 * a built, powered defence structure runs the SAME rules as a capital ship's
 * turret (`core/combat/mountFireControl` + `mountTargeting`, shared with
 * `WeaponMountTicker.tickCapitalMounts`):
 *
 *  - each mount keeps its OWN target: the hostile its calibre prefers most
 *    (`mountPriority`: AA → small craft, 5" → gunships and light capitals,
 *    heavy guns → capitals; plain turrets: nearest), among those within its
 *    reach, inside its arc (a casemate's embrasure, turned by the structure's
 *    rotation) and slow enough across its sights to track;
 *  - STICKY: it holds that target through a brief loss (`TARGET_HOLD_MS`);
 *  - it LEADS the target for its shell speed, TURNS at its traverse rate, and
 *    fires only when on target and reloaded;
 *  - LOCK TO FIRE (root invariant #19, universal): each mount builds its own
 *    lock on its current target (`stepLock` with `lockSeconds`: the mount's
 *    size profile, the structure's reach, the target's signature and motion,
 *    `STRUCTURE_SENSOR`; capped at `maxSeconds` rather than impossible) and
 *    fires only once that lock is COMPLETE. A new
 *    target restarts the lock; a target it can't lock for `lostGraceSeconds`
 *    restarts it too. testMode `instantLock` (`setInstantLocks`) completes a
 *    lock on the step it starts.
 *
 * Runs on the room's turret tick (100 ms, `TURRET_TICK_MS`), not the 60 Hz
 * loop: slewing uses the real elapsed time, so a 16" barbette turns at
 * 0.07 rad/s whatever the tick. The server is the only writer of the mount
 * angles (#12); they ride the snapshot (`structureMountAngles`) and the client
 * eases its drawn barrels toward them.
 *
 * Allocation-free in steady state (#14): per-structure state is made once, the
 * candidate list is the caller's pooled array.
 */
import { rotateMountToward } from '../../core/ai/WeaponMountController.js';
import { leadArcBearing, mountCanEngage, onTarget } from '../../core/combat/mountFireControl.js';
import { mountPriority, type TargetClass } from '../../core/combat/mountTargeting.js';
import { getWeapon, type WeaponDef } from '../../core/combat/WeaponCatalogue.js';
import { newLock, stepLock, type LockEntry } from '../../core/combat/lockState.js';
import { lockSeconds, type LockInputs } from '../../core/combat/lockTime.js';
import { LOCK_TUNING, STRUCTURE_SENSOR, WEAPON_LOCK_PROFILE, type MountSize } from '../../shared-types/combat/lockProfile.js';
import type { StructureKind } from '../../shared-types/structureKinds.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import type { StructureRecord } from './StructureRegistry.js';

/** A target a defence turret may engage, written by the room into a pooled
 *  array (`StructureGridHooks.turretTargets`). Already filtered to hostiles. */
export interface TurretTargetView {
  /** Damage id (swarm registry id, or the player id). */
  id: string;
  /** Swarm entity id, or -1 for a player. */
  entityId: number;
  /** Set for a player target. */
  playerId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  cls: TargetClass;
  /** Lock signature (u): the target's hull radius (`signatureFor`). */
  signature: number;
}

/** A mount keeps aiming at a target it briefly can't engage for this long. */
export const TARGET_HOLD_MS = 1000;
/** Longest slew step one turret tick may take (a stalled timer never makes a
 *  barrel jump). */
const MAX_DT_SEC = 0.25;
const DEG = Math.PI / 180;
/** The pilots' lock tuning with no "too slow to lock" cut-off (clamped to
 *  `LOCK_TUNING.maxSeconds` at the call instead). */
const STRUCTURE_LOCK_TUNING = { ...LOCK_TUNING, maxSeconds: Infinity };

/** What the ticker asks its owner to do. */
export interface StructureMountSink {
  /** Fill `out` with hostile targets within `range` of (x, y) for `owner`;
   *  return how many. */
  targets(x: number, y: number, range: number, owner: string, out: TurretTargetView[]): number;
  /** Fire mount `mountIdx` along unit (ndx, ndy) at `target` (already on
   *  target and reloaded). Returns false when it could not fire (no
   *  munitions), so the reload is not spent. */
  fire(rec: StructureRecord, kind: StructureKind, mountIdx: number, mount: WeaponMount, def: WeaponDef,
    ndx: number, ndy: number, target: TurretTargetView, nowMs: number): boolean;
}

interface MountState {
  angles: Float32Array;
  targetIds: (string | null)[];
  reloadMs: Float64Array;
  lastOkMs: Float64Array;
  /** Per-mount lock on `targetIds[i]` (made once, reused; `target` '' = none). */
  locks: LockEntry[];
}

export class StructureMountTicker {
  private readonly states = new Map<string, MountState>();
  private readonly candidates: TurretTargetView[] = [];
  private lastTickMs = -1;
  private instantLocks = false;
  /** Reused lock-time inputs (#14). */
  private readonly lockIn: LockInputs = {
    refSize: 1, tracking: 1, reach: 1, sensor: STRUCTURE_SENSOR, pilotSpeed: 1, signature: 1, dx: 0, dy: 0, dvx: 0, dvy: 0,
  };

  constructor(private readonly sink: StructureMountSink) {}

  /** testMode `instantLock`: every structure lock completes on the step it starts. */
  setInstantLocks(on: boolean): void {
    this.instantLocks = on;
  }

  /** Seconds since the previous turret tick (clamped), for slewing. Call
   *  once per tick before `tick`. */
  beginTick(nowMs: number, defaultDtSec: number): number {
    const dt = this.lastTickMs < 0 ? defaultDtSec : Math.min(MAX_DT_SEC, Math.max(0, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;
    return dt;
  }

  /** The slewed arc-local angles of a structure's mounts (catalogue order), or
   *  undefined before its first tick. */
  anglesOf(id: string): Float32Array | undefined {
    return this.states.get(id)?.angles;
  }

  /** Drop state for structures no longer in the registry. */
  prune(isLive: (id: string) => boolean): void {
    for (const id of this.states.keys()) if (!isLive(id)) this.states.delete(id);
  }

  /** Test trigger (`test_reload_turrets`): every mount is reloaded now. */
  reloadAll(): void {
    for (const st of this.states.values()) st.reloadMs.fill(-Infinity);
  }

  /** Clear a structure's targets (unpowered / destroyed); its barrels stay put. */
  idle(rec: StructureRecord): void {
    const st = this.states.get(rec.id);
    if (!st) return;
    st.targetIds.fill(null);
    for (const e of st.locks) resetLock(e, '');
  }

  /**
   * One fire-control step for a built, powered defence structure. Returns the
   * first mount's target (for the inspector + the target slice) or null.
   *
   * Reach is the kind's catalogue `weaponRange`, never scaled by the
   * structure's level: ranges are physical, the gun doesn't change with the
   * building, and its shells fly only their own `maxTicks` (2026-11-10 — a
   * levelled reach engaged targets the shells couldn't reach). Level upgrades
   * damage and HP instead.
   */
  tick(rec: StructureRecord, kind: StructureKind, mounts: ReadonlyArray<WeaponMount>, nowMs: number, dtSec: number): TurretTargetView | null {
    const n = mounts.length;
    let st = this.states.get(rec.id);
    if (!st || st.angles.length !== n) {
      st = {
        angles: new Float32Array(n),
        targetIds: new Array<string | null>(n).fill(null),
        reloadMs: new Float64Array(n).fill(-Infinity),
        lastOkMs: new Float64Array(n),
        locks: Array.from({ length: n }, () => newLock('', true)),
      };
      this.states.set(rec.id, st);
    }
    const frame = (rec.rot ?? 0) * DEG;
    const reach = kind.weaponRange ?? 0;
    // One candidate gather per structure: its mounts sit at its centre.
    const count = this.sink.targets(rec.x, rec.y, reach, rec.owner, this.candidates);
    const cands = this.candidates;
    const cosA = Math.cos(frame), sinA = Math.sin(frame);
    let first: TurretTargetView | null = null;
    for (let i = 0; i < n; i++) {
      const mount = mounts[i]!;
      const mx = rec.x + (mount.localX * cosA - mount.localY * sinA);
      const my = rec.y + (mount.localX * sinA + mount.localY * cosA);
      let best = -1;
      let engageable = false;
      const prev = st.targetIds[i];
      if (prev !== null) {
        for (let j = 0; j < count; j++) if (cands[j]!.id === prev) { best = j; break; }
        if (best >= 0) {
          const t = cands[best]!;
          engageable = mountCanEngage(mount, frame, t.x - mx, t.y - my, reach, t.vx, t.vy);
        }
        if (engageable) st.lastOkMs[i] = nowMs;
        else if (best < 0 || nowMs - st.lastOkMs[i]! > TARGET_HOLD_MS) { best = -1; st.targetIds[i] = null; }
      }
      if (best < 0) {
        // Search: lowest (priority, distance) among targets it can engage.
        let bestPri = Infinity, bestD2 = Infinity;
        for (let j = 0; j < count; j++) {
          const t = cands[j]!;
          const dx = t.x - mx, dy = t.y - my;
          if (!mountCanEngage(mount, frame, dx, dy, reach, t.vx, t.vy)) continue;
          const d2 = dx * dx + dy * dy;
          const pri = mountPriority(mount.size, t.cls);
          if (pri < bestPri || (pri === bestPri && d2 < bestD2)) { bestPri = pri; bestD2 = d2; best = j; }
        }
        if (best >= 0) { engageable = true; st.lastOkMs[i] = nowMs; }
      }
      const lock = st.locks[i]!;
      if (best < 0) {
        st.targetIds[i] = null;
        if (lock.target !== '') resetLock(lock, '');
        st.angles[i] = rotateMountToward(st.angles[i]!, 0, mount, dtSec);
        continue;
      }
      const t = cands[best]!;
      st.targetIds[i] = t.id;
      const locked = this.stepMountLock(lock, mount, t, mx, my, reach, dtSec);
      if (first === null) first = t;
      const def = getWeapon(mount.weaponId);
      const dx = t.x - mx, dy = t.y - my;
      const dist = Math.hypot(dx, dy);
      // Lead with the shell speed (a homing missile and a beam need none).
      const want = leadArcBearing(dx, dy, t.vx, t.vy, def.mode === 'projectile' ? def.speed : 0, frame, mount.baseAngle);
      st.angles[i] = rotateMountToward(st.angles[i]!, want, mount, dtSec);
      if (!engageable) continue; // held through a brief loss: aim, don't fire
      if (!locked) continue; // lock to fire: still acquiring
      if (nowMs - st.reloadMs[i]! < this.reloadMsOf(kind, def)) continue;
      if (!onTarget(want, st.angles[i]!, dist)) continue;
      const a = frame + mount.baseAngle + st.angles[i]!;
      if (this.sink.fire(rec, kind, i, mount, def, -Math.sin(a), Math.cos(a), t, nowMs)) st.reloadMs[i] = nowMs;
    }
    return first;
  }

  /**
   * Advance mount lock `e` on target `t` by `dtSec`; true once LOCKED. A new
   * target restarts it (a structure only targets hostiles: no failsafe ring).
   */
  private stepMountLock(e: LockEntry, mount: WeaponMount, t: TurretTargetView, mx: number, my: number, reach: number, dtSec: number): boolean {
    if (e.target !== t.id) resetLock(e, t.id);
    if (e.stage === 'locked') return true;
    if (this.instantLocks) {
      e.stage = 'locked';
      e.progress = 1;
      return true;
    }
    const p = WEAPON_LOCK_PROFILE[(mount.size ?? 'none') as MountSize | 'none'];
    const inp = this.lockIn;
    inp.refSize = p.refSize;
    inp.tracking = p.tracking;
    inp.reach = reach;
    inp.signature = t.signature;
    inp.dx = t.x - mx;
    inp.dy = t.y - my;
    inp.dvx = t.vx; // the structure is fixed
    inp.dvy = t.vy;
    // A fixed battery always gets there in the end: a lock past `maxSeconds`
    // (a 16" gun on a destroyer) takes `maxSeconds` instead of being
    // impossible, so a heavy gun never sits blind on the only target it has.
    // Out of reach stays unlockable (Infinity).
    const secs = Math.min(lockSeconds(inp, STRUCTURE_LOCK_TUNING), LOCK_TUNING.maxSeconds);
    const ev = stepLock(e, dtSec, secs, secs * LOCK_TUNING.failsafeMul, LOCK_TUNING.lostGraceSeconds, LOCK_TUNING.decayMul);
    // Unlockable past the grace: start over on the same target (it stays the
    // mount's target; targeting is the arc/tracking rules', not the lock's).
    if (ev === 'dropped') resetLock(e, t.id);
    return ev === 'locked'; // an already-locked entry returned above
  }

  /** A mount's reload: the beam cadence for a hitscan turret (a continuous
   *  stream, see `resolveTurretBeam`), else the kind's `fireRateMs`. */
  private reloadMsOf(kind: StructureKind, def: WeaponDef): number {
    if (def.mode === 'hitscan') return (def.cooldownTicks / 60) * 1000;
    return kind.fireRateMs ?? (def.cooldownTicks / 60) * 1000;
  }
}

/** Restart lock `e` on `target` ('' = no target), in place (#14). */
function resetLock(e: LockEntry, target: string): void {
  e.target = target;
  e.stage = 'acquiring';
  e.progress = 0;
  e.lostFor = 0;
}
