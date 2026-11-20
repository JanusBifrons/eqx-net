/**
 * Rigs of structure family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import type { RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = {};
