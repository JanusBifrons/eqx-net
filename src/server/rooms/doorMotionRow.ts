/**
 * Solid doors (docs/plans/door-power.md, slice 9): a Shield Gate's or
 * Airlock's door segment into its room-state row (`encodeDoorMotion`,
 * shared-types/structureStateWire.ts; decoded by the client in
 * `structureStateDecode.ts`). Fields are assigned only on change (A2), so a
 * still door costs nothing; a late joiner rebuilds the door from the row (#16).
 *
 * The door states come from the GateController through the slice host
 * (`GateDoorSource`: `gateStateFor` / `airlockStateFor`).
 */
import { rigClipIndex } from '../../core/articulation/rig.js';
import { rigForStructureKind } from '../../core/articulation/rigCatalogue.js';
import { DOOR_POS_MAX, type GateType } from '../../core/structures/gateGeometry.js';
import type { AirlockState, GateState } from '../../core/structures/gateLogic.js';
import type { DoorSegment } from '../../core/structures/doorMotion.js';
import { STRUCTURE_DEFAULTS as SD, encodeDoorMotion, type DoorMotionFields, type DoorMotionSeg } from '../../shared-types/structureStateWire.js';
import type { StructureState } from './schema/SectorState.js';

/** Where the writer reads a gate's doors (the GateController). */
export interface GateDoorSource {
  gateStateFor(id: string): Readonly<GateState> | undefined;
  airlockStateFor(id: string): Readonly<AirlockState> | undefined;
}

function doorClipIndex(kind: string, clipId: string): number {
  const rig = rigForStructureKind(kind);
  const i = rig !== null ? rigClipIndex(rig, clipId) : -1;
  if (i < 0) throw new Error(`${kind} has no door clip ${clipId}`);
  return i;
}

/** The door clips' indices in their rigs (the `rigClip` byte names them). */
export const GATE_DOOR_CLIP = doorClipIndex('shield_gate', 'door');
export const AIRLOCK_DOOR_A_CLIP = doorClipIndex('shield_airlock', 'door-a');
export const AIRLOCK_DOOR_B_CLIP = doorClipIndex('shield_airlock', 'door-b');

/** The airlock end the row carries: the one that re-segmented last (on a tie,
 *  the one heading open). The interlock opens an end only once the other
 *  reads position 0, and a shut, still end never re-segments, so the end not
 *  carried is always shut and still. */
export function airlockRowDoorIsB(a: Readonly<AirlockState>): boolean {
  const sa = a.doorA.seg, sb = a.doorB.seg;
  return sb.t0 > sa.t0 || (sb.t0 === sa.t0 && sb.dir > sa.dir);
}

const SHUT: DoorSegment = { p0: 0, t0: 0, dir: -1, level: 0 };
const fields: DoorMotionFields = { rigClip: 0, rigStart: 0, rigHold: 0, gateOpen: 0 };

/** The segment + clip a gate's row carries, into `fields`. */
function encodeGateDoors(id: string, type: GateType, src: GateDoorSource): DoorMotionFields {
  let seg: Readonly<DoorMotionSeg> = SHUT;
  let clip = type === 'gate' ? GATE_DOOR_CLIP : AIRLOCK_DOOR_A_CLIP;
  if (type === 'gate') {
    const g = src.gateStateFor(id);
    if (g !== undefined) seg = g.door.seg;
  } else {
    const a = src.airlockStateFor(id);
    if (a !== undefined) {
      const b = airlockRowDoorIsB(a);
      seg = b ? a.doorB.seg : a.doorA.seg;
      if (b) clip = AIRLOCK_DOOR_B_CLIP;
    }
  }
  return encodeDoorMotion(seg, clip, fields);
}

/** Write a gate's / airlock's door motion into its row (on change only). The
 *  door kinds' rig fields belong to this writer, not `writeRigClipRow`. */
export function writeDoorMotionRow(id: string, type: GateType, src: GateDoorSource, st: StructureState): void {
  writeFields(encodeGateDoors(id, type, src), st);
}

/** A teleporter chamber's resting doors: open and still (no track yet). */
const OPEN_REST: DoorSegment = { p0: DOOR_POS_MAX, t0: 0, dir: 1, level: 0 };

/** Redesign T2 — a chamber pad's blast-door segment (`PadDoors.segFor`;
 *  undefined = resting open) into its row: both doorways ride the one `door`
 *  clip. On change only, like the gate row. */
export function writePadDoorRow(seg: Readonly<DoorMotionSeg> | undefined, kind: string, st: StructureState): void {
  writeFields(encodeDoorMotion(seg ?? OPEN_REST, doorClipIndex(kind, 'door'), fields), st);
}

function writeFields(f: Readonly<DoorMotionFields>, st: StructureState): void {
  if ((st.rigClip ?? SD.rigClip) !== f.rigClip) st.rigClip = f.rigClip;
  if ((st.rigStart ?? SD.rigStart) !== f.rigStart) st.rigStart = f.rigStart;
  if ((st.rigHold ?? SD.rigHold) !== f.rigHold) st.rigHold = f.rigHold;
  if ((st.gateOpen ?? SD.gateOpen) !== f.gateOpen) st.gateOpen = f.gateOpen;
}
