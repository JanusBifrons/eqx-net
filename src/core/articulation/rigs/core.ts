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
import { withUnfold, type UnfoldSpec } from '../unfoldRig.js';
import { CAPITAL } from '../../../shared-types/structureKinds.js';

/** The Capital unfolds from its crate: a 4 × 4 grid of crate-sized panels
 *  (140 × 140 on the 560 × 560 footprint) stacked on one crate block at the
 *  centre, sliding out ring by ring (`unfoldRig.ts`). */
export const CAPITAL_UNFOLD: UnfoldSpec = { w: CAPITAL.footprint.w, h: CAPITAL.footprint.h, cols: 4, rows: 4 };

/** The Capital's built-in crane bay (first load home): the shared crane arm,
 *  plus its unfold panels and the `unfold` / `pack` clips (the crane rests
 *  while they play). */
export const CAPITAL_CRANE_DEF: RigDef = withUnfold(craneRigDef(CAPITAL_BAY), CAPITAL_UNFOLD);

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [CAPITAL_CRANE_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = { capital: 'capital-crane' };
