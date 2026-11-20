/**
 * Style C family "storage" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Storage + habitation: storage vault, habitat, tower, cargo bay.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  CONTAINERS, CRANE, LAMP_AMBER, SLAB_DARK, SOOT, STEEL, chamferBox, core, deck, glow, grime, lamp, mixColor,
  poly, scalePts, stencil, stripe, truss, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '';

/** Cargo hold (`cargo_bay`): a slab hold floor, four muted shipping
 *  containers in a 2 x 2 grid, an X-braced gantry (two rail trusses and a
 *  bridge truss across), worn stripes on the deck ends. */
function cargoHold(c: StyleCtx): void {
  const out = deck(c);
  core(c, chamferBox(-134, -74, 268, 148, 16), SLAB_DARK, 8, Math.PI / 2);
  grime(c, -130, -70, 260, 140, 8, 4);
  let k = 0;
  for (const cy of [-36, 36]) {
    for (const cx of [-64, 64]) {
      const box = chamferBox(cx - 54, cy - 28, 108, 56, 6);
      poly(c, box, CONTAINERS[(c.seed + k++) % 4]!, 'paint', 14, 3, { roof: [2, 8] });
      for (let x = cx - 46; x <= cx + 46; x += 8) poly(c, stripe(box, 0, x, 2), mixColor(SLAB_DARK, 0x000000, 0.3), 'metal', 1, 0.5);
      for (const [ex, ey] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        poly(c, chamferBox(cx + ex * 48 - 4, cy + ey * 22 - 4, 8, 8, 2), SOOT, 'metal', 1.5, 0.6);
      }
    }
  }
  grime(c, -120, -64, 240, 128, 8, 5);
  stencil(c, '33', -106, -58, 20);
  for (const s of [-1, 1]) {
    truss(c, [-138, s * 82], [138, s * 82], 14, STEEL, 28);
    wornStripe(c, scalePts(out, 1, 0.8), 0, s * 146, 10, 40 + s);
  }
  truss(c, [12, -90], [12, 90], 20, CRANE, 34);
  poly(c, chamferBox(0, -12, 24, 24, 5), mixColor(CRANE, SLAB_DARK, 0.4), 'metal', 6, 1.5);
  glow(c, chamferBox(6, -3, 12, 6, 2), LAMP_AMBER, 0.8);
  if (c.livery) c.sigils.push({ x: -146, y: 0, r: 9 });
  for (const s of [-1, 1]) lamp(c, 12, s * 86, 3.5, LAMP_AMBER);
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  cargo_bay: cargoHold,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
