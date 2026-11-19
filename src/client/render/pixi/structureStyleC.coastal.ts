/**
 * Style C family "coastal" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Coastal guns: AA quad, 5 in, 8 in casemate, 11 in, 16 in barbette, Lindemann, 80 cm siege gun.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import { type StyleDrawerTable } from './structureStyleKit.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '';

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {};
