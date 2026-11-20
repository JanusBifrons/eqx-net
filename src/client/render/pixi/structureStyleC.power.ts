/**
 * Style C family "power" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Power + solar: solar, battery, battery bank, reactor.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, frame, glow, grime,
  lamp, ngon, poly, rivets, scaffold, stencil, stripe, strut, walkway, wornStripe, type StyleCtx,
  type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '';

/** Power station (`reactor`): an octagonal containment keep with a deep pit
 *  and a hard-lit core, inside a square truss frame, four ribbed cooling
 *  blocks on the frame's corners, struts in, walkways, one block scaffolded. */
function powerStation(c: StyleCtx): void {
  deck(c);
  grime(c, -180, -180, 360, 360, 10, 3);
  frame(c, -150, -150, 300, 300, 30, 10);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const blk = core(c, chamferBox(sx * 140 - 36, sy * 140 - 36, 72, 72, 16), SLAB_LIGHT, 24, 0);
    for (let k = -2; k <= 2; k++) poly(c, stripe(blk, Math.PI / 2, sy * 140 + k * 11, 4), SOOT, 'metal', 2, 0.8);
    wornStripe(c, blk, 0, sx * 140 - sx * 24, 8, 30 + sx + 3 * sy);
    strut(c, [sx * 76, sy * 76], [sx * 112, sy * 112], 10, 14);
    lamp(c, sx * 140 + sx * 26, sy * 140 - sy * 26, 3.5, LAMP_AMBER);
  }
  core(c, ngon(0, 0, 108, 8, Math.PI / 8), SLAB, 30, 0);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    rivets(c, [Math.cos(a) * 92, Math.sin(a) * 92], [Math.cos(a + Math.PI / 4) * 92, Math.sin(a + Math.PI / 4) * 92], 13);
  }
  poly(c, ngon(0, 0, 66, 8, Math.PI / 8), SLAB_DARK, 'metal', -6, 5);
  poly(c, ngon(0, 0, 40, 8, Math.PI / 8), SOOT, 'metal', -2, 2);
  glow(c, ngon(0, 0, 22, 8, Math.PI / 8), c.live ? 0xffc070 : 0x3a2418, 0.9);
  c.lit(0, 0, 8, c.live ? LAMP_WHITE : 0x3a2418);
  for (const s of [-1, 1]) walkway(c, [-110, s * 186], [110, s * 186], 12);
  scaffold(c, 96, 96, 84, 84, 17, 12);
  stencil(c, '07', -18, 112, 22);
  if (c.livery) c.sigils.push({ x: -140, y: -140, r: 18 });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  reactor: powerStation,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
