/**
 * Style C family "transport" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Transport + docks: teleporter, pocket pad, freight dock; large teleporter + alien gate
 * (the Ancients' gate Astrolabe: structureStyleC.transport.astrolabe.ts).
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  CONTAINERS, CRANE, HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SIGN_GLASS, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT,
  STEEL, chamferBox, chevron, clipHalf, core, deck, glow, grime, lamp, mixColor, ngon, poly, rivets,
  scaffold, scalePts, stencil, stripe, strut, truss, walkway, weld, wornStripe, type StyleCtx,
  type StyleDrawerTable,
} from './structureStyleKit.js';
import { DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y } from '../../../core/articulation/rigCatalogue.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import { doorLeafContext } from './structureStyleC.fences.gate.js';
import { chamber, chamberStatus } from './structureStyleC.transport.chamber.js';
import { ASTROLABE_RIG_HOOK, alienGate } from './structureStyleC.transport.astrolabe.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 't5c';

/** Medium dock (`freight_dock`, 1000 × 400): the loading pad is OUTSIDE the
 *  building (the rig's `lip` apron, past the open -y edge, pixi), so the
 *  building itself is solid: one thin hazard edge along the open side, a
 *  plated crane apron deck behind it, and on that deck the raised crane
 *  tower (centred on the rig crane's pivot) the slewing crane is seated on,
 *  braced by truss legs into the hull. Behind the bay-mouth gantry truss:
 *  the slab dock house with a lit sign, a container stack on the roof, and
 *  the small truss-boom roof crane folded along it. */
function dock(c: StyleCtx): void {
  const out = deck(c);
  const hw = c.W / 2, hh = c.H / 2;
  const lipY = -hh + 120;
  // Open edge: a single thin hazard strip (the pad itself is the rig's apron).
  poly(c, clipHalf(scalePts(out, 0.985), 0, 1, -hh + 12), HAZARD, 'hazard', 1.5, 1);
  // Crane apron deck: plated building along the open edge.
  const apron = core(c, chamferBox(-hw + 34, -hh + 16, 2 * hw - 68, lipY - (-hh + 16) - 8, 14), SLAB_DARK, 10, 0);
  grime(c, -hw + 40, -hh + 18, 2 * hw - 80, lipY + hh - 30, 14, 7);
  for (const x of [-300, -150, 150, 300]) weld(c, [x, -hh + 22], [x, lipY - 14]);
  rivets(c, [-hw + 50, -hh + 24], [-90, -hh + 24], 16);
  rivets(c, [90, -hh + 24], [hw - 50, -hh + 24], 16);
  for (const s of [-1, 1]) wornStripe(c, apron, 0, s * (hw - 60), 12, 70 + s);
  truss(c, [-hw + 40, lipY], [hw - 40, lipY], 22, STEEL, 12);
  // Dock house: one symmetric slab, rivet rows, weld seams, grime.
  const house = core(c, chamferBox(-hw + 36, lipY + 12, 2 * hw - 72, hh - lipY - 52, 22), SLAB, 18, Math.PI / 2);
  grime(c, -hw + 42, lipY + 14, 2 * hw - 84, hh - lipY - 56, 22, 2);
  rivets(c, [-hw + 56, lipY + 20], [hw - 56, lipY + 20], 14);
  for (const x of [-210, 210]) weld(c, [x, lipY + 24], [x, hh - 46]);
  for (const s of [-1, 1]) wornStripe(c, house, 0, s * (hw - 52), 14, 20 + s);
  walkway(c, [-hw + 56, hh - 18], [hw - 56, hh - 18], 14);
  // The lit sign: heavy frame, dark glass, an amber "in" arrow, a crate icon.
  const sx0 = -hw + 56, sy = lipY + 34, sh = 60;
  poly(c, chamferBox(sx0 - 6, sy - 6, 206, sh + 12, 12), SLAB_LIGHT, 'metal', 6, 2);
  glow(c, chamferBox(sx0, sy, 194, sh, 9), SIGN_GLASS, 1);
  glow(c, chevron(sx0 + 46, sy + sh / 2, 50, 38, 12, -1), LAMP_AMBER, 1.1);
  glow(c, chamferBox(sx0 + 104, sy + sh / 2 - 18, 46, 36, 6), LAMP_WHITE, 0.9);
  glow(c, chamferBox(sx0 + 116, sy + sh / 2 - 8, 22, 16, 3), SIGN_GLASS, 1);
  stencil(c, '12', sx0 + 4, sy + sh + 14, 30);
  // Container stack on the roof (2 × 3), muted shipping colours.
  let k = 0;
  for (const cy of [lipY + 58, lipY + 130]) {
    for (const cx of [-130, -10, 110]) {
      const box = chamferBox(cx - 54, cy - 28, 108, 56, 6);
      poly(c, box, CONTAINERS[(c.seed + k++) % 4]!, 'paint', 14, 3, { roof: [2, 8] });
      for (let x = cx - 46; x <= cx + 46; x += 8) poly(c, stripe(box, 0, x, 2), mixColor(SLAB_DARK, 0x000000, 0.3), 'metal', 1, 0.5);
    }
  }
  // Folded roof crane: a pivot tower, a truss boom laid back along the roof,
  // a trolley and hook block parked near the tip.
  const rx = hw - 90, py = lipY + 92;
  poly(c, chamferBox(rx - 28, py - 28, 56, 56, 12), SLAB_LIGHT, 'metal', 30, 5, { roof: [3, 10] });
  poly(c, chamferBox(rx - 17, py - 17, 34, 34, 8), SLAB_DARK, 'metal', 2, 1);
  truss(c, [rx - 6, py], [rx - 230, py], 28, CRANE, 34);
  poly(c, chamferBox(rx - 190, py - 16, 26, 32, 5), mixColor(CRANE, SLAB_DARK, 0.4), 'metal', 6, 1.5);
  poly(c, chamferBox(rx - 224, py - 9, 18, 18, 4), SLAB_LIGHT, 'metal', 4, 1);
  scaffold(c, rx - 220, py + 30, 160, hh - py - 64, 20, 8);
  lamp(c, rx, py, 4, LAMP_AMBER);
  // Crane tower: the raised superstructure the slewing crane is seated on,
  // centred on the rig crane's pivot. A soot shadow cast inward, truss legs
  // braced down into the hull, a tall plated block, the slew-seat top plate
  // (the rig's plinth sits on it) with a bolt ring.
  const tx = DOCK_CRANE_PIVOT_X, ty = -DOCK_CRANE_PIVOT_Y;
  const TW = 204, TH = 116;
  poly(c, chamferBox(tx - TW / 2 + 12, ty - TH / 2 + 16, TW, TH, 20), SOOT, 'mark', 0.4, 1, { alpha: 0.85 });
  for (const s of [-1, 1]) {
    truss(c, [tx + s * (TW / 2 + 8), ty - TH / 2 + 10], [tx + s * (TW / 2 + 8), ty + TH / 2 + 14], 16, STEEL, 26);
    strut(c, [tx + s * (TW / 2 - 6), ty + TH / 2 - 10], [tx + s * (TW / 2 + 46), ty + TH / 2 + 28], 10, 22);
    strut(c, [tx + s * (TW / 2 - 6), ty - TH / 2 + 14], [tx + s * (TW / 2 + 46), ty - TH / 2 + 4], 10, 22);
  }
  poly(c, chamferBox(tx - TW / 2 - 5, ty - TH / 2 - 3, TW + 10, TH + 8, 22), 0x0a0c0e, 'metal', 44, 2);
  const tower = core(c, chamferBox(tx - TW / 2, ty - TH / 2, TW, TH, 20), SLAB_LIGHT, 48, Math.PI / 2);
  // Hazard bands on the tower's flanks, rivet rows along its long faces.
  for (const s of [-1, 1]) poly(c, stripe(tower, 0, tx + s * (TW / 2 - 16), 12), HAZARD, 'hazard', 1, 0.6);
  for (const s of [-1, 1]) rivets(c, [tx - TW / 2 + 30, ty + s * (TH / 2 - 7)], [tx + TW / 2 - 30, ty + s * (TH / 2 - 7)], 12);
  poly(c, chamferBox(tx - 52, ty - 52, 104, 104, 18), 0x2c3035, 'metal', 4, 2);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    poly(c, ngon(tx + Math.cos(a) * 47, ty + Math.sin(a) * 47, 2.2, 6), RIVET, 'metal', 1, 0.6);
  }
  for (const [ex, ey] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) lamp(c, tx + ex * (TW / 2 - 10), ty + ey * (TH / 2 - 10), 3.5, LAMP_AMBER);
  if (c.livery) c.sigils.push({ x: hw - 70, y: hh - 64, r: 22 });
  for (const s of [-1, 1]) lamp(c, s * (hw - 34), -hh + 24, 4, LAMP_WHITE);
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  freight_dock: dock,
  // Teleporter redesign T4: the chamber (structureStyleC.transport.chamber.ts).
  teleporter: chamber,
  pocket_pad: chamber,
  // T5: the large teleporter (2120, eight towers) shares the drawer.
  teleporter_large: chamber,
  alien_gate: alienGate,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {
  // The chamber's blast doors wear the gatehouse leaf art.
  'tp-doors': { partArt: doorLeafContext },
  'tp-doors-large': { partArt: doorLeafContext },
  'alien-astrolabe': ASTROLABE_RIG_HOOK,
};

/** This family's live body-state hooks (`BodyStatusHook`): the chamber's
 *  floor lights, door strips and charge coils. */
export const status: BodyStatusHookTable = {
  teleporter: chamberStatus,
  pocket_pad: chamberStatus,
  teleporter_large: chamberStatus,
};
