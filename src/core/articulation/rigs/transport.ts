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

/** The freight dock's crane (bay geometry and arm: `craneRig.ts`). */
export const DOCK_CRANE_DEF: RigDef = craneRigDef(FREIGHT_DOCK_BAY);

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [DOCK_CRANE_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { freight_dock: 'dock-crane' };
