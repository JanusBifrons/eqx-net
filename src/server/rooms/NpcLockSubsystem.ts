/**
 * NPC target locks on pilots (fire control). Locking goes both ways: an NPC
 * must LOCK a pilot before it may fire at them,
 * by the same rules a pilot locks with (`lockSeconds`: the NPC's sensor and
 * weapon tracking vs the pilot's size, crossing speed and range). The pilot
 * sees every lock building on them through the own-ship `lockedBy` snapshot
 * slice (#16).
 *
 * Every connected pilot is tracked (lock-to-fire is universal), so the step
 * is O(pilots × hostile NPCs) every 6 ticks. A drone fires at a pilot only
 * with a completed lock on that pilot (`fireBlocked`, keyed by the drone's AI
 * target). A capital's turrets each fire only with the capital's completed
 * lock on THEIR own target (`WeaponMountTicker.tickCapitalMounts`), so a
 * capital holds one lock per pilot it engages, built with whichever of its
 * gun sizes locks that pilot fastest (AA on a fighter, the main battery on a
 * capital). Structure turrets are not gated yet (PR 1d).
 *
 * Steady state allocates nothing (#14): an entry and its wire row are created
 * when an NPC starts locking someone, then mutated in place; the per-step
 * sweep uses a generation stamp.
 */
import { LOCK_TUNING, sensorFor, signatureFor } from '../../shared-types/combat/lockProfile.js';
import { capLockSeconds, lockSeconds, type LockInputs } from '../../core/combat/lockTime.js';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { groupGeometry } from './LockSubsystem.js';
import { hasTurretFireControl } from '../../core/combat/mountReach.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

/** Wire row: who is locking the pilot. `t` = `s:<entityId>`, `s` 1 acquiring / 2 locked, `p` 0..100. */
export interface WireLockedBy { t: string; s: 1 | 2; p: number }

export interface NpcPose { x: number; y: number; vx: number; vy: number }

export interface NpcLockDeps {
  /** Pilots to protect (every tracked player). */
  pilots(): Iterable<string>;
  /** The pilot's active ship pose + kind; false when they have none. */
  pilotPose(pilotId: string, out: NpcPose): ShipKind | null;
  /** Call `visit` for every NPC currently hostile to the pilot. */
  forEachHostileNpc(pilotId: string, visit: (npcId: string, entityId: number) => void): void;
  /** NPC pose + kind; null when gone. */
  npcPose(npcId: string, out: NpcPose): ShipKind | null;
  /** testMode `instantLock` on the pilot: every NPC lock on them completes
   *  the step it starts, whatever the size/tracking terms, while in reach. */
  instantLock?(pilotId: string): boolean;
  /** testMode `lockTimeCapS` (room option): no NPC lock takes longer than
   *  this many seconds while in reach (0 = the first step). Undefined = off. */
  lockTimeCapS?(): number | undefined;
  /** "An NPC that is attacking stays hostile" (owner 2026-11-12): called every
   *  lock step while `npcId` is locking or holds a lock on `pilotId` (in reach,
   *  trackable). The room re-stamps that NPC's hostility to the pilot, so the
   *  30 s decay runs from when its own lock drops. */
  refreshHostility?(npcId: string, pilotId: string): void;
}

interface Entry {
  npcId: string;
  progress: number; // 0..1
  locked: boolean;
  lostFor: number;
  gen: number;
  wire: WireLockedBy;
}

interface PilotState {
  entries: Map<string, Entry>;
  wire: WireLockedBy[];
}

interface Geo { refSize: number; tracking: number; reach: number; sensor: number; absRange: boolean }

const LOCK_DT = 0.1;

export class NpcLockSubsystem {
  private readonly pilots = new Map<string, PilotState>();
  /** Lock profiles per kind: one for a drone (its whole loadout); one per
   *  mount size for a capital (each turret engages on its own). */
  private readonly geoByKind = new Map<string, Geo[]>();
  private readonly pilot: NpcPose = { x: 0, y: 0, vx: 0, vy: 0 };
  private readonly npc: NpcPose = { x: 0, y: 0, vx: 0, vy: 0 };
  private readonly inputs: LockInputs = {
    refSize: 1, tracking: 1, reach: 1, sensor: 1, pilotSpeed: 1, signature: 1, dx: 0, dy: 0, dvx: 0, dvy: 0,
  };
  private gen = 0;
  // Per-step scratch for the visitor (no closure allocation per pilot).
  private curState: PilotState | null = null;
  private curPilotId = '';
  private curSignature = 1;
  private curInstant = false;
  private curCap: number | undefined = undefined;

  constructor(private readonly deps: NpcLockDeps) {}

  private geos(kind: ShipKind): Geo[] {
    let gs = this.geoByKind.get(kind.id);
    if (!gs) {
      const mounts = kind.mounts ?? [];
      const sensor = sensorFor(kind);
      gs = [];
      if (hasTurretFireControl(kind)) {
        const bySize = new Map<string, WeaponMount[]>();
        for (const m of mounts) {
          const k = m.size ?? 'none';
          const list = bySize.get(k);
          if (list) list.push(m); else bySize.set(k, [m]);
        }
        for (const ms of bySize.values()) gs.push({ ...groupGeometry(ms), sensor });
      } else {
        gs.push({ ...groupGeometry(mounts), sensor });
      }
      this.geoByKind.set(kind.id, gs);
    }
    return gs;
  }

  forget(pilotId: string): void {
    this.pilots.delete(pilotId);
  }

  /** An NPC left the world: drop every lock it held. */
  forgetNpc(npcId: string): void {
    for (const st of this.pilots.values()) {
      if (st.entries.delete(npcId)) this.rebuildWire(st);
    }
  }

  wireFor(pilotId: string): WireLockedBy[] | undefined {
    const st = this.pilots.get(pilotId);
    return st && st.wire.length > 0 ? st.wire : undefined;
  }

  /** True when `npcId` holds a completed lock on `pilotId`. */
  isLocked(npcId: string, pilotId: string): boolean {
    return this.pilots.get(pilotId)?.entries.get(npcId)?.locked === true;
  }

  /**
   * Gate for an NPC drone shot at `targetId` (the drone's AI target): refused
   * when the target is a tracked pilot and `npcId` holds no COMPLETED lock on
   * them. Aim direction plays no part, so a lock on one pilot never licenses
   * a shot at another. Non-pilot targets (NPCs, structures, displaced hulls)
   * are not gated here.
   */
  fireBlocked(npcId: string, targetId: string): boolean {
    const st = this.pilots.get(targetId);
    if (st) return st.entries.get(npcId)?.locked !== true;
    // A pilot no step has seen yet: nobody holds a lock on them.
    return this.isPilot(targetId);
  }

  /** Advance every NPC lock by one lock step. Call every 6 server ticks. */
  step(): void {
    this.gen++;
    for (const pilotId of this.deps.pilots()) {
      let st = this.pilots.get(pilotId);
      if (!st) {
        st = { entries: new Map(), wire: [] };
        this.pilots.set(pilotId, st);
      }
      const kind = this.deps.pilotPose(pilotId, this.pilot);
      if (!kind) {
        if (st.entries.size > 0) { st.entries.clear(); st.wire.length = 0; }
        continue;
      }
      this.curState = st;
      this.curPilotId = pilotId;
      this.curSignature = signatureFor(kind);
      this.curInstant = this.deps.instantLock?.(pilotId) === true;
      this.curCap = this.deps.lockTimeCapS?.();
      this.deps.forEachHostileNpc(pilotId, this.visit);
      // Sweep: NPCs that stopped locking this step keep their progress for the
      // grace window, then drop.
      let changed = false;
      for (const [id, e] of st.entries) {
        if (e.gen === this.gen) continue;
        e.lostFor += LOCK_DT;
        if (e.lostFor > LOCK_TUNING.lostGraceSeconds) { st.entries.delete(id); changed = true; }
      }
      if (changed || st.wire.length !== st.entries.size) this.rebuildWire(st);
    }
    // Pilots who left fire control.
    if (this.pilots.size > 0) {
      for (const id of this.pilots.keys()) if (!this.isPilot(id)) this.pilots.delete(id);
    }
  }

  private isPilot(id: string): boolean {
    for (const p of this.deps.pilots()) if (p === id) return true;
    return false;
  }

  private readonly visit = (npcId: string, entityId: number): void => {
    const st = this.curState!;
    const kind = this.deps.npcPose(npcId, this.npc);
    if (!kind) return;
    const gs = this.geos(kind);
    const inp = this.inputs;
    inp.pilotSpeed = 1;
    inp.signature = this.curSignature;
    inp.dx = this.pilot.x - this.npc.x;
    inp.dy = this.pilot.y - this.npc.y;
    inp.dvx = this.pilot.vx - this.npc.vx;
    inp.dvy = this.pilot.vy - this.npc.vy;
    // The fastest of the NPC's lock profiles (a drone has one).
    let secs = Infinity;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      if (g.reach <= 0) continue;
      inp.refSize = g.refSize;
      inp.tracking = g.tracking;
      inp.absRange = g.absRange;
      inp.reach = g.reach;
      inp.sensor = g.sensor;
      const s = capLockSeconds(lockSeconds(inp, LOCK_TUNING), inp, LOCK_TUNING, this.curCap);
      if (s < secs) secs = s;
    }
    if (this.curInstant && this.inReach(gs)) secs = 0;
    let e = st.entries.get(npcId);
    if (!Number.isFinite(secs)) {
      // Out of reach or can't track: not locking this step (grace applies).
      return;
    }
    if (!e) {
      e = { npcId, progress: 0, locked: false, lostFor: 0, gen: 0, wire: { t: `s:${entityId}`, s: 1, p: 0 } };
      st.entries.set(npcId, e);
    }
    e.gen = this.gen;
    e.lostFor = 0;
    if (!e.locked) {
      e.progress = secs === 0 ? 1 : Math.min(1, e.progress + LOCK_DT / Math.max(0.05, secs));
      if (e.progress >= 1) e.locked = true;
    }
    e.wire.s = e.locked ? 2 : 1;
    e.wire.p = Math.round(e.progress * 100);
    // Its own live lock keeps it hostile. Out of reach (or unable to track)
    // the NPC isn't visited, so the refresh stops and the 30 s decay starts.
    this.deps.refreshHostility?.(npcId, this.curPilotId);
  };

  /** The pilot (this.inputs dx/dy) is within reach of any lock profile. */
  private inReach(gs: Geo[]): boolean {
    const d = Math.hypot(this.inputs.dx, this.inputs.dy);
    for (let i = 0; i < gs.length; i++) if (gs[i]!.reach > 0 && d <= gs[i]!.reach * LOCK_TUNING.reachSlack) return true;
    return false;
  }

  private rebuildWire(st: PilotState): void {
    st.wire.length = 0;
    for (const e of st.entries.values()) st.wire.push(e.wire);
  }
}
