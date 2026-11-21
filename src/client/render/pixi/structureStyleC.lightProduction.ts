/**
 * Style C family "lightProduction" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Light production: smelter, silicon works, hydroponics, fabricator, munitions works, reclaimer,
 * gas collector, research lab, refinery.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SLAB_DARK, SLAB_LIGHT, STEEL, chamferBox, core, deck, grime, lamp, ngon,
  poly, rivets, scaffold, stencil, strut, truss, weld, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import * as gaslab from './structureStyleC.lightProduction.gaslab.js';
import * as hydro from './structureStyleC.lightProduction.hydro.js';
import * as smelt from './structureStyleC.lightProduction.smelt.js';
import { WORK_DARK, WORK_ON, WORK_STARVED, bakeSlits, workGlowStatus, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';
import * as muni from './structureStyleC.lightProduction.muni.js';

export { SLIT_DEAD } from './structureStyleC.lightProduction.work.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'r2';

/** The refinery's work-glow slits (x, y, w, h in px, the drawer's frame):
 *  one on each tank bunker, two on the column. Baked as dead glass
 *  (`SLIT_DEAD`); the live overlay (`status`) lights them while it works. */
export const REFINERY_SLITS: ReadonlyArray<WorkSlit> = [
  [-124, -2, 24, 4], [100, -2, 24, 4], [-20, -14, 40, 4], [-20, 58, 40, 4],
];

/** Where the starved refinery's red no-supply mark sits: on the open column face,
 *  between the scaffold and the upper slit, clear of the trusses (x, y, half height, stroke width; px). */
export const REFINERY_MARK: WorkMark = [0, -38, 13, 3];

/** Refinery: a tall chamfered cracking column on the axis, two octagonal
 *  tank bunkers mirrored either side and strutted in, pipe-rack trusses
 *  above and below, a scaffold up the column, small hard work-glow slits
 *  (baked dark, lit by the live overlay while it works, `status`). */
function refinery(c: StyleCtx): void {
  deck(c);
  grime(c, -170, -130, 340, 260, 12, 6);
  for (const s of [-1, 1]) truss(c, [-150, s * 104], [150, s * 104], 24, STEEL, 12);
  for (const s of [-1, 1]) {
    const tank = core(c, ngon(s * 112, 0, 56, 8, Math.PI / 8), 0x3a3631, 22, Math.PI / 2);
    poly(c, ngon(s * 112, 0, 26, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 2);
    rivets(c, [s * 112 - 40, -40], [s * 112 + 40, -40], 10);
    wornStripe(c, tank, Math.PI / 2, 30, 8, 50 + s);
    strut(c, [s * 58, 0], [s * 40, 0], 12, 16);
    for (const t of [-1, 1]) strut(c, [s * 112, t * 58], [s * 112, t * 92], 8, 14);
  }
  const col = core(c, chamferBox(-40, -124, 80, 248, 20), SLAB_LIGHT, 40, 0);
  weld(c, [-30, -40], [30, -40]);
  weld(c, [-30, 40], [30, 40]);
  wornStripe(c, col, Math.PI / 2, 84, 12, 60);
  bakeSlits(c, REFINERY_SLITS);
  scaffold(c, -48, -124, 96, 64, 16, 12);
  stencil(c, '21', -15, 8, 24);
  if (c.livery) c.sigils.push({ x: 0, y: -26, r: 16 });
  lamp(c, 0, -112, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -104, 3.5, LAMP_AMBER);
}

// ── Live work glow (BodyStatusHook, structureStyleC.lightProduction.work.ts) ──

/** Refinery status codes (the family's shared `WORK_*` codes). */
export const REFINERY_DARK = WORK_DARK;
export const REFINERY_WORKING = WORK_ON;
export const REFINERY_STARVED = WORK_STARVED;

/** This family's live body state (`BodyStatusHook`, drawn on the socket-nub
 *  overlay, structureSocketNubs.ts): every kind lit only while it works. */
export const status: BodyStatusHookTable = {
  refinery: workGlowStatus(REFINERY_SLITS, REFINERY_MARK),
  ...muni.status,
  ...gaslab.status,
  ...hydro.status,
  ...smelt.status,
};

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  refinery,
  ...muni.kinds,
  ...gaslab.kinds,
  ...hydro.kinds,
  ...smelt.kinds,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
