/**
 * Solid doors (docs/plans/door-power.md, slice 9) — the client side of the
 * door row. A Shield Gate's / Airlock's / teleporter chamber's (redesign T3,
 * `hasDoorRig`; written by `writePadDoorRow`) room-state row carries one door
 * segment (`encodeDoorMotion`, shared-types/structureStateWire.ts; written by
 * the server's `writeDoorMotionRow`). This decodes it IN PLACE into
 *   - `doorA` / `doorB`: each door's segment (position = `doorPosAt`, the one
 *     door clock; the end the row does not carry is shut and still: the
 *     airlock interlock);
 *   - `rigClip`: the door clip scrubbed from that segment (`from` =
 *     `doorClipTime(p0)`, `rate` = clip ticks per game tick), so predWorld's
 *     leaves (`syncRigClips`) and the drawn rig pose from the same segment.
 * `doorA` / `doorB` are the truth (the deck lights read them too). The old
 * GATE_OPEN_* mask on `gateOpen` fed the gate shield spans, which are gone
 * (slice 11): it is no longer decoded.
 * A row with every door field still at its default (nothing written yet)
 * decodes to the kind's REST pose (`doorRestPos`: a chamber stands open and
 * still, a gate shut), scrubbed like any other segment.
 * Allocation-free once a row's door objects exist (#14). A late joiner gets
 * the whole door from one row (#16).
 */
import type { StructureRenderState } from '../../core/contracts/IRenderer.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { gateTypeOf } from '../../core/structures/gateGeometry.js';
import { doorRestPos, hasDoorRig } from '../../core/structures/doorLeafBoxes.js';
import { GATE_OPEN_A, GATE_OPEN_B } from '../../core/structures/gateLogic.js';
import { doorClipTime } from '../../core/structures/doorMotion.js';
import {
  DOOR_MOTION_OPEN,
  STRUCTURE_DEFAULTS as D,
  decodeDoorMotion,
  decodeRigClipIndex,
  type DoorMotionSeg,
  type StructureStateView,
} from '../../shared-types/structureStateWire.js';

/** The airlock's end-B clip id (every other door clip is end A / the gate). */
const DOOR_B_CLIP = 'door-b';

/** The kind's door is carried on its row: a door rig (`hasDoorRig`: shield
 *  gate, airlock, teleporter chamber). */
export function isDoorKind(kind: string | undefined): boolean {
  return hasDoorRig(kind);
}

function shut(s: DoorMotionSeg): void {
  s.p0 = 0;
  s.t0 = 0;
  s.dir = -1;
  s.level = 0;
}

/** Decode a door kind's row onto `out` (see the file comment). */
export function decodeDoorRow(v: StructureStateView, out: StructureRenderState, kind: string): void {
  const rig = rigForStructureKind(kind);
  const idx = decodeRigClipIndex(v.rigClip ?? D.rigClip);
  const clip = rig !== null ? (rig.clips[idx] ?? rig.clips[0]) : undefined;
  const isB = clip?.id === DOOR_B_CLIP;
  const a = (out.doorA ??= { p0: 0, t0: 0, dir: -1, level: 0 });
  let seg: DoorMotionSeg = a;
  if (gateTypeOf(kind) === 'airlock') {
    const b = (out.doorB ??= { p0: 0, t0: 0, dir: -1, level: 0 });
    if (isB) { seg = b; shut(a); } else shut(b);
  } else {
    out.doorB = undefined;
  }
  const gateOpen = v.gateOpen ?? D.gateOpen;
  const rigStart = v.rigStart ?? D.rigStart;
  const rigHold = v.rigHold ?? D.rigHold;
  decodeDoorMotion(gateOpen, rigStart, rigHold, seg);
  // Nothing written yet: the rig's rest pose, still (a chamber rests open).
  if (gateOpen === D.gateOpen && rigStart === D.rigStart && rigHold === D.rigHold) {
    const rest = doorRestPos(kind);
    if (rest > 0) { seg.p0 = rest; seg.t0 = 0; seg.dir = 1; seg.level = 0; }
  }
  if (clip === undefined) {
    out.rigClip = undefined;
    return;
  }
  const r = (out.rigClip ??= { clipId: '', startTick: 0 });
  r.clipId = clip.id;
  r.startTick = seg.t0;
  r.from = doorClipTime(seg.p0);
  r.rate = doorClipTime(seg.dir * seg.level); // position units per tick -> clip ticks per tick
  r.holdTicks = undefined;
  r.cargo = undefined;
  r.targetX = undefined;
  r.targetY = undefined;
}

/** A row that is not (or not yet known to be) a door kind: no door fields. */
export function clearDoorRow(out: StructureRenderState): void {
  out.doorA = undefined;
  out.doorB = undefined;
}

/** GATE_OPEN_* bits from a door row without its kind: clip index 1 is only
 *  ever the airlock's end B. Undefined when nothing heads open. Nothing in the
 *  client reads it any more; kept only for the gates integration test (the
 *  server-span slice reworks that test, then this goes). */
export function doorOpenMaskOf(v: StructureStateView): number | undefined {
  if (((v.gateOpen ?? D.gateOpen) & DOOR_MOTION_OPEN) === 0) return undefined;
  return decodeRigClipIndex(v.rigClip ?? D.rigClip) === 1 ? GATE_OPEN_B : GATE_OPEN_A;
}
