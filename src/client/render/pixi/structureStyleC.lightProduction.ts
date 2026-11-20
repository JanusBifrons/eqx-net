/**
 * Style C family "lightProduction" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Light production: smelter, silicon works, hydroponics, fabricator, munitions works, reclaimer,
 * gas collector, research lab, refinery.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SLAB_DARK, SLAB_LIGHT, STEEL, chamferBox, core, deck, glow, grime, lamp, ngon,
  poly, rivets, scaffold, stencil, strut, truss, weld, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '';

/** Refinery: a tall chamfered cracking column on the axis, two octagonal
 *  tank bunkers mirrored either side and strutted in, pipe-rack trusses
 *  above and below, a scaffold up the column, small hard work-glow slits. */
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
    glow(c, chamferBox(s * 112 - 12, -2, 24, 4, 1.5), LAMP_AMBER, 0.7);
  }
  const col = core(c, chamferBox(-40, -124, 80, 248, 20), SLAB_LIGHT, 40, 0);
  weld(c, [-30, -40], [30, -40]);
  weld(c, [-30, 40], [30, 40]);
  wornStripe(c, col, Math.PI / 2, 84, 12, 60);
  for (const y of [-12, 60]) glow(c, chamferBox(-20, y - 2, 40, 4, 1.5), LAMP_AMBER, 0.6);
  scaffold(c, -48, -124, 96, 64, 16, 12);
  stencil(c, '21', -15, 8, 24);
  if (c.livery) c.sigils.push({ x: 0, y: -26, r: 16 });
  lamp(c, 0, -112, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -104, 3.5, LAMP_AMBER);
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  refinery,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
