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
 *    fires only when on target and reloaded.
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
}

/** A mount keeps aiming at a target it briefly can't engage for this long. */
export const TARGET_HOLD_MS = 1000;
/** Longest slew step one turret tick may take (a stalled timer never makes a
 *  barrel jump). */
const MAX_DT_SEC = 0.25;
const DEG = Math.PI / 180;

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
}

export class StructureMountTicker {
  private readonly states = new Map<string, MountState>();
  private readonly candidates: TurretTargetView[] = [];
  private lastTickMs = -1;

  constructor(private readonly sink: StructureMountSink) {}

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
    if (st) st.targetIds.fill(null);
  }

  /**
   * One fire-control step for a built, powered defence structure. `lvlMul`
   * scales reach (level upgrades). Returns the first mount's target (for the
   * inspector + the target slice) or null.
   */
  tick(rec: StructureRecord, kind: StructureKind, mounts: ReadonlyArray<WeaponMount>, nowMs: number, dtSec: number, lvlMul: number): TurretTargetView | null {
    const n = mounts.length;
    let st = this.states.get(rec.id);
    if (!st || st.angles.length !== n) {
      st = {
        angles: new Float32Array(n),
        targetIds: new Array<string | null>(n).fill(null),
        reloadMs: new Float64Array(n).fill(-Infinity),
        lastOkMs: new Float64Array(n),
      };
      this.states.set(rec.id, st);
    }
    const frame = (rec.rot ?? 0) * DEG;
    const reach = (kind.weaponRange ?? 0) * lvlMul;
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
      if (best < 0) {
        st.targetIds[i] = null;
        st.angles[i] = rotateMountToward(st.angles[i]!, 0, mount, dtSec);
        continue;
      }
      const t = cands[best]!;
      st.targetIds[i] = t.id;
      if (first === null) first = t;
      const def = getWeapon(mount.weaponId);
      const dx = t.x - mx, dy = t.y - my;
      const dist = Math.hypot(dx, dy);
      // Lead with the shell speed (a homing missile and a beam need none).
      const want = leadArcBearing(dx, dy, t.vx, t.vy, def.mode === 'projectile' ? def.speed : 0, frame, mount.baseAngle);
      st.angles[i] = rotateMountToward(st.angles[i]!, want, mount, dtSec);
      if (!engageable) continue; // held through a brief loss: aim, don't fire
      if (nowMs - st.reloadMs[i]! < this.reloadMsOf(kind, def)) continue;
      if (!onTarget(want, st.angles[i]!, dist)) continue;
      const a = frame + mount.baseAngle + st.angles[i]!;
      if (this.sink.fire(rec, kind, i, mount, def, -Math.sin(a), Math.cos(a), t, nowMs)) st.reloadMs[i] = nowMs;
    }
    return first;
  }

  /** A mount's reload: the beam cadence for a hitscan turret (a continuous
   *  stream, see `resolveTurretBeam`), else the kind's `fireRateMs`. */
  private reloadMsOf(kind: StructureKind, def: WeaponDef): number {
    if (def.mode === 'hitscan') return (def.cooldownTicks / 60) * 1000;
    return kind.fireRateMs ?? (def.cooldownTicks / 60) * 1000;
  }
}
