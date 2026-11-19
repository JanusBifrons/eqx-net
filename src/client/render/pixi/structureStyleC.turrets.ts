/**
 * Style C family "turrets" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Turrets: turret, laser bolt, missile, autocannon, mine layer.
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
