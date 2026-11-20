/**
 * Style C family "fences" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Fences + gates: shield pylon, shield gate, airlock, territory lock.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, RIVET, SLAB, SLAB_DARK, SOOT, core, deck, glow, lamp, ngon, poly,
  strip, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f2py';

/** Shield-wall emitter colour (lit, powered) and its dead glass (dark). */
const EMIT = 0x6fe2f0;
const EMIT_DEAD = 0x16262a;

/** Shield pylon (drawn for 120 × 120, scaled by the short side): a squat
 *  octagonal plinth with an emitter in stacked rings on top; heat-sink fins
 *  on the four diagonals (walls plug into the side studs). Powered, the emitter glows wall-teal; dark when unpowered. */
function shieldPylon(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 120;
  deck(c);
  // Heat-sink fins on the diagonals: three thin plates each.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a);
    for (const off of [-7, 0, 7]) {
      const ox = -sa * off * k, oy = ca * off * k;
      poly(c, strip([ca * 36 * k + ox, sa * 36 * k + oy], [ca * 54 * k + ox, sa * 54 * k + oy], 3 * k), SLAB_DARK, 'metal', 8, 0.8);
    }
  }
  // The plinth and its bolt ring.
  const plinth = core(c, ngon(0, 0, 40 * k, 8, Math.PI / 8), SLAB, 22, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8, r = 35 * k;
    poly(c, ngon(Math.cos(a) * r, Math.sin(a) * r, 1.8 * k, 6), RIVET, 'metal', 24, 0.5);
  }
  wornStripe(c, plinth, Math.PI / 2, 30 * k, 5 * k, 7);
  // The emitter: collar, dark ring, lens.
  poly(c, ngon(0, 0, 27 * k, 16), SLAB_DARK, 'metal', 30, 2);
  poly(c, ngon(0, 0, 20 * k, 16), SOOT, 'metal', 26, 1.5);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    poly(c, ngon(Math.cos(a) * 23.5 * k, Math.sin(a) * 23.5 * k, 1.6 * k, 6), RIVET, 'metal', 32, 0.5);
  }
  glow(c, ngon(0, 0, 13 * k, 16), c.live ? EMIT : EMIT_DEAD, 0.95);
  c.lit(0, 0, 7 * k, c.live ? 0xd8fbff : EMIT_DEAD);
  lamp(c, W / 2 - 8 * k, -H / 2 + 8 * k, 2.5 * k, LAMP_AMBER);
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  shield_pylon: shieldPylon,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
