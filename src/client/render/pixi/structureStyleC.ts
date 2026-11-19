/**
 * Structure style C, "shipyard brutalist" (docs/plans/structure-restyle.md §4,
 * slices 1f, 1i). Built in space, not on a rock: each building is a solid
 * gunmetal core slab inside an exposed X-braced truss frame, with strut
 * connectors where modules join, gantry walkways and a maintenance scaffold
 * partly wrapping it. Ordered: the outline is the clean symmetric chamfer
 * (`structureOutline(kind, 'c')`), modules are aligned and mirrored about the
 * vertical axis. Gritty: soot / gunmetal / oxidised steel, grime streaks, rivet
 * rows, weld seams, stained patch panels, chipped stencils and livery stripes,
 * few small hard amber / white work lamps. Drawn into the ordinary structure
 * draw plan with the shared kit; the forge bakes it, exactly like style A.
 *
 * Phase 0a (docs/plans/structure-restyle-stage4.md §4): the drawers live one
 * file per family (`structureStyleC.<family>.ts`, families in
 * structureFamilies.ts); this file only assembles them. The palette and the
 * parts they draw with are in structureStyleKit.ts.
 */
import type { StructureStyleDef, StyleDrawerTable } from './structureStyleKit.js';
import type { StructureFamilyId } from './structureFamilies.js';
import * as core from './structureStyleC.core.js';
import * as power from './structureStyleC.power.js';
import * as fences from './structureStyleC.fences.js';
import * as lightProduction from './structureStyleC.lightProduction.js';
import * as mining from './structureStyleC.mining.js';
import * as heavyIndustry from './structureStyleC.heavyIndustry.js';
import * as turrets from './structureStyleC.turrets.js';
import * as coastal from './structureStyleC.coastal.js';
import * as storage from './structureStyleC.storage.js';
import * as transport from './structureStyleC.transport.js';

/** One family file: its drawers and its drawing version. */
export interface StyleCFamily { kinds: StyleDrawerTable; version: string }

/** Style C's family files, by family id. */
export const STYLE_C_FAMILIES: Readonly<Record<StructureFamilyId, StyleCFamily>> = {
  core, power, fences, lightProduction, mining, heavyIndustry, turrets, coastal, storage, transport,
};

const families = Object.values(STYLE_C_FAMILIES);

/** Style C's drawer table: every family's drawers, each kind stamped with its
 *  family's version (the stored bake key, `structureStyleVersion`). */
export const STYLE_C: StructureStyleDef = {
  label: 'Shipyard brutalist',
  kinds: Object.assign({}, ...families.map((f) => f.kinds)) as StructureStyleDef['kinds'],
  kindVersions: Object.fromEntries(families.flatMap((f) => Object.keys(f.kinds).map((k) => [k, f.version]))),
};
