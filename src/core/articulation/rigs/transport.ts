/**
 * Rigs of structure family "transport" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Transport + docks: teleporter, pocket pad, freight dock, large teleporter, alien gate.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { RigDef } from '../rig.js';
import { FREIGHT_DOCK_BAY, craneRigDef } from '../craneRig.js';
import type { RigKindMap } from './rigFamily.js';
import { doorClip, leaf } from './fences.js';
import { PAD_SPECS, padDoorwayHalf, padHalfExtent, type TeleporterKind } from '../../../shared-types/teleport.js';

/** The freight dock's crane (bay geometry and arm: `craneRig.ts`). */
export const DOCK_CRANE_DEF: RigDef = craneRigDef(FREIGHT_DOCK_BAY);

// ── tp-doors (teleporter chamber blast doors) ────────────────────────────────
//
// Teleporter redesign T1. A chamber pad (`isPadChamberKind`) has a doorway at
// each local ±y end (`padChamber.ts`), each shut by a pair of the gatehouse's
// physical slide leaves (`leaf`, `doorClip`, DOOR_LEAF_THICKNESS from
// `fences.ts`). Each leaf is half the doorway (`padDoorwayHalf`) and runs on
// the wall band's centre line; open, it has slid its whole length into the
// wall stub beside the doorway, so the doorway is fully clear. (The
// gatehouse's `doorOpenTravel` is not used: the transport family's house
// outline is a hexagon that does not bound the square chamber; the stubs do.)
//
// BOTH doorways ride ONE clip `door` (one door-motion segment per structure:
// the jump shuts and reopens both ends together). Clip time 0 = shut, the
// clip end = open, as every door rig. The doors REST OPEN: `idleClip` holds
// the clip's end pose when no clip record exists (never driven, or cleared),
// so an idle pad stands open and only the jump cycle shuts it.

/** The chamber door rig for a pad kind's size. */
function tpDoorsDef(id: string, kind: TeleporterKind): RigDef {
  const len = padDoorwayHalf(kind);
  const y = padHalfExtent(kind) - PAD_SPECS[kind].post / 2;
  const parts = [
    leaf('leaf-a-left', -1, y, len, len),
    leaf('leaf-a-right', 1, y, len, len),
    leaf('leaf-b-left', -1, -y, len, len),
    leaf('leaf-b-right', 1, -y, len, len),
  ];
  return { id, parts, clips: [doorClip('door', parts.map((p) => p.id), len)], idleClip: 'door' };
}

/** Chamber doors on the 800 pads (teleporter, transit pad). */
export const TP_DOORS_DEF: RigDef = tpDoorsDef('tp-doors', 'teleporter');
/** Chamber doors on the 2120 large teleporter. */
export const TP_DOORS_LARGE_DEF: RigDef = tpDoorsDef('tp-doors-large', 'teleporter_large');

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [DOCK_CRANE_DEF, TP_DOORS_DEF, TP_DOORS_LARGE_DEF];

/** Structure kind id -> rig id, for this family's kinds. The Ancients' gate
 *  has no doors (it keeps its posts and iris). */
export const rigOfKind: RigKindMap = {
  freight_dock: 'dock-crane', teleporter: 'tp-doors', pocket_pad: 'tp-doors', teleporter_large: 'tp-doors-large',
};
