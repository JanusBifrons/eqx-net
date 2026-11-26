/**
 * Teleporter chamber blast doors, server side (teleporter redesign T2).
 *
 * A chamber pad (`isPadChamberKind`) shuts both doorways for the jump and
 * reopens after it. This is the gatehouse door machinery driven from the jump
 * cycle instead of from ship occupancy (NOT a gate type: no gate access, no
 * shield emitter): one `DoorTrack` per pad (`doorMotion.ts`, the one door
 * clock), scrubbed onto the pad's `tp-doors` rig with `startStructureRigClip`
 * (both doorways ride the one `door` clip), the leaf hit boxes re-posed with
 * `writeDoorLeafBoxes`, and the segment on the room-state row through
 * `writePadDoorRow` (`doorMotionRow.ts`).
 *
 * Speed follows power like the gatehouse: level = `doorLevelFromSupply` of the
 * pad's grid; a free pad with no grid (the Transit Pad) runs at full level. A
 * moving door draws full power (grid `setActive`, the gate rule).
 *
 * Door state is never saved: it follows `tpPhase`. A pad with no track (never
 * driven, or a restored IDLE pad) stands open at the rig's rest pose.
 *
 * Steady state is allocation-free (#14); a segment edge allocates its clip
 * record, as any rig clip start does.
 */
import { DOOR_POS_MAX, DOOR_POWER_LEVELS } from '../../core/structures/gateGeometry.js';
import {
  doorClipTime,
  doorLevelFromSupply,
  doorMoving,
  doorPosAt,
  driveDoor,
  newDoorTrack,
  type DoorSegment,
  type DoorTrack,
} from '../../core/structures/doorMotion.js';
import { isFreeTeleporterKind, isPadChamberKind } from '../../shared-types/teleport.js';
import type { StructureRecord } from './StructureRegistry.js';
import { startStructureRigClip, type RigClipCmd } from './structureRigClip.js';
import { writeDoorLeafBoxes } from './doorLeafBoxes.js';
import type { PadDoorDriver } from './padDoorDriver.js';

/** A pad's rotation in radians (`onPad`, `padPushDir`, the leaf boxes). */
export function padAngle(rec: { readonly rot?: number }): number {
  return ((rec.rot ?? 0) * Math.PI) / 180;
}

export interface PadDoorHooks {
  /** The room's game tick (the rig clock). */
  serverTick(): number;
  /** The room's game time (ms), for the door re-segment throttle. */
  nowMs(): number;
  /** The structure's grid supply fraction 0..1 (`PowerSummary.supplyFrac`). */
  supplyFrac(id: string): number;
  /** Full draw while a door moves, trickle while still (grid `setActive`). */
  setActive(rec: StructureRecord, active: boolean): void;
  /** Post a worker command (`RIG_CLIP`). */
  post(cmd: RigClipCmd): void;
  /** The pad's swarm-record hit boxes (`gateHitBoxes`; leaf tail re-posed). */
  hitBoxes?(id: string): Float32Array | undefined;
}

export class PadDoors implements PadDoorDriver {
  private readonly tracks = new Map<string, DoorTrack>();
  /** Reused scrub argument for `startStructureRigClip`. */
  private readonly scrub = { from: 0, rate: 0 };

  constructor(private readonly h: PadDoorHooks) {}

  /** The doors' power level 0..15: full for a free pad (no grid), 0 for a
   *  pad not built, else from its grid's supply. */
  level(rec: StructureRecord): number {
    if (!rec.isConstructed) return 0;
    if (isFreeTeleporterKind(rec.kind)) return DOOR_POWER_LEVELS;
    return doorLevelFromSupply(this.h.supplyFrac(rec.id));
  }

  /**
   * Steer a chamber pad's doors toward open / shut at its power level (call
   * at every phase change and on the structure tick, so a power change mid-
   * travel re-segments). Returns true when the segment changed (the room row
   * must be re-synced). A non-chamber kind, or an open pad with no track, is
   * a no-op.
   */
  drive(rec: StructureRecord, open: boolean): boolean {
    if (!isPadChamberKind(rec.kind)) return false;
    let t = this.tracks.get(rec.id);
    if (t === undefined) {
      if (open) return false; // resting open already
      t = newDoorTrack(DOOR_POS_MAX);
      t.seg.dir = 1; // open and still: the rest pose
      this.tracks.set(rec.id, t);
    }
    const tick = this.h.serverTick();
    const changed = driveDoor(t, open, this.level(rec), tick, this.h.nowMs());
    if (changed) {
      const seg = t.seg;
      this.scrub.from = doorClipTime(seg.p0);
      this.scrub.rate = (seg.dir * seg.level) / DOOR_POWER_LEVELS;
      startStructureRigClip(rec, 'door', seg.t0, this.h.post, undefined, undefined, this.scrub);
    }
    const pos = doorPosAt(t.seg, tick);
    const boxes = this.h.hitBoxes?.(rec.id);
    if (boxes !== undefined) writeDoorLeafBoxes(rec.kind, padAngle(rec), pos, pos, boxes);
    if (!isFreeTeleporterKind(rec.kind)) this.h.setActive(rec, doorMoving(t, tick));
    return changed;
  }

  /** Both of the pad's doorways are fully shut (a pad with no doors, or an
   *  undriven chamber, is never shut). */
  shut(rec: StructureRecord): boolean {
    const t = this.tracks.get(rec.id);
    return t !== undefined && doorPosAt(t.seg, this.h.serverTick()) === 0;
  }

  /** The pad's doors cannot move (power level 0) and are not shut. */
  stalled(rec: StructureRecord): boolean {
    return isPadChamberKind(rec.kind) && !this.shut(rec) && this.level(rec) === 0;
  }

  /** The door segment for the room-state row (undefined: resting open). */
  segFor(id: string): Readonly<DoorSegment> | undefined {
    return this.tracks.get(id)?.seg;
  }

  /** The pad left the world. */
  remove(id: string): void {
    this.tracks.delete(id);
  }
}
