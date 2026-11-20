/**
 * Rigs of structure family "core" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Core: capital + connector.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { RigDef } from '../rig.js';
import { CAPITAL_BAY, craneRigDef } from '../craneRig.js';
import type { RigKindMap } from './rigFamily.js';

/** The Capital's built-in crane bay (first load home): the shared crane arm. */
export const CAPITAL_CRANE_DEF: RigDef = craneRigDef(CAPITAL_BAY);

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [CAPITAL_CRANE_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { capital: 'capital-crane' };
