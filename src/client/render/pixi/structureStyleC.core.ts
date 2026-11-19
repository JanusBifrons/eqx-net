/**
 * Style C family "core" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Core: the beacon (capital) and the hex node (connector). Parked Capital tier (stage-4 plan §3).
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, SIGN_GLASS, SLAB, SLAB_DARK, SLAB_LIGHT, STEEL, chamferBox, core, deck, frame,
  glow, grime, lamp, mixColor, ngon, poly, rivets, scaffold, scalePts, stencil, strip, strut, walkway, weld,
  wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import { structureSockets } from '../../../shared-types/structureKinds.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '';

/** The beacon (capital): a heavy octagonal keep holding the owner's big sigil
 *  screen, inside a square X-braced truss frame tied to four corner pads by
 *  struts; a walkway along the foot, a maintenance scaffold over one corner. */
function beacon(c: StyleCtx): void {
  deck(c);
  const keep = core(c, chamferBox(-160, -160, 320, 320, 64), SLAB, 26, 0);
  grime(c, -150, -150, 300, 300, 14, 1);
  for (const s of [-1, 1]) {
    rivets(c, [-96, s * 150], [96, s * 150]);
    weld(c, [s * 150, -96], [s * 150, 96]);
    wornStripe(c, keep, 0, s * 136, 10, 10 + s);
  }
  frame(c, -172, -172, 344, 344, 36, 10);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    poly(c, chamferBox(sx * 200 - 24, sy * 200 - 24, 48, 48, 12), SLAB_LIGHT, 'metal', 16, 4, { roof: [2, 8] });
    strut(c, [sx * 140, sy * 140], [sx * 186, sy * 186], 9, 14);
    lamp(c, sx * 200, sy * 200, 4, LAMP_AMBER);
  }
  walkway(c, [-150, 238], [150, 238], 14);
  walkway(c, [-150, -238], [150, -238], 14);
  // The keep's crown: a dark bezel and the lit screen.
  poly(c, chamferBox(-118, -118, 236, 236, 46), SLAB_DARK, 'metal', 4, 3);
  glow(c, chamferBox(-106, -106, 212, 212, 40), mixColor(c.accent, SIGN_GLASS, 0.8), 0.7);
  if (c.livery) c.sigils.push({ x: 0, y: 0, r: 90, screen: true });
  else c.lit(0, 0, 10, LAMP_WHITE);
  scaffold(c, 70, -160, 90, 70, 18, 10);
  stencil(c, '01', -24, 122, 30);
  for (const s of [-1, 1]) lamp(c, s * 112, -112, 3.5, LAMP_WHITE);
}

/** Hex node (connector): a hex core, one radial clamp strut out to each cable
 *  socket (`structureSockets`: one per face of the flat-top hex, so six), a
 *  dark socket with a small amber slit, a worn stripe across. */
function hexNode(c: StyleCtx): void {
  const out = deck(c);
  const hex = core(c, scalePts(out, 0.62), SLAB, 10, 0);
  wornStripe(c, hex, Math.PI / 2, 12, 5, 3);
  // Struts along each socket's outward normal, in this Pixi frame (y down).
  for (const s of structureSockets(c.kindId)) {
    const nx = s.nx, ny = -s.ny;
    poly(c, strip([nx * 17, ny * 17], [nx * 25, ny * 25], 5), STEEL, 'metal', 6, 1);
  }
  poly(c, ngon(0, 0, 9, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 1.5);
  glow(c, chamferBox(-5, -1.5, 10, 3, 1), LAMP_AMBER, 0.7);
  c.lit(0, 0, 3, LAMP_AMBER);
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  capital: beacon,
  connector: hexNode,
};
