/**
 * Style C light production: the gas collector and the research lab
 * (docs/plans/structure-restyle-stage4.md §6). Both bake their work-glow
 * glass dark and light it on the live overlay only while they work
 * (`bakeSlits` / `workGlowStatus`, structureStyleC.lightProduction.work.ts);
 * starved shows the red no-supply mark. The gas collector starves when it is
 * powered outside a nebula, the lab when a job is missing an input (the
 * server's `prodState`). `kinds` and `status` are spread into the family's
 * tables (structureStyleC.lightProduction.ts).
 */
import {
  HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck,
  grime, lamp, ngon, poly, rivets, scaffold, stencil, strip, strut, truss, walkway, weld, wornStripe,
  type Pt, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { BodyStatusHookTable } from './structureSocketNubs.js';
import { bakeSlits, workGlowStatus, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';

// ── Gas collector (300 × 300) ───────────────────────────────────────────────

/** Where the ram-scoop funnel sits (its ring is centred a little high). */
const SCOOP: Pt = [0, -10];

/** The gas collector's work-glow slits (x, y, w, h in px, the drawer's frame):
 *  one up each compressor drum, one on the scoop collar, one on the bottle rack. */
export const GAS_SLITS: ReadonlyArray<WorkSlit> = [
  [-118, -40, 4, 26], [114, -40, 4, 26], [-14, 52, 28, 4], [-26, 128, 52, 4],
];

/** The starved gas collector's no-supply mark: on the scoop's hub cap, in the
 *  open throat (nothing coming in), clear of the trusses. */
export const GAS_MARK: WorkMark = [SCOOP[0], SCOOP[1], 12, 3];

/** Gas collector: a ram-scoop funnel ring on the axis (a stepped throat with
 *  radial intake vanes), a ribbed compressor drum either side piped up to a
 *  pipe-rack truss, a rack of pressure bottles below, one drum scaffolded. */
function gasCollector(c: StyleCtx): void {
  const [sx, sy] = SCOOP;
  deck(c);
  grime(c, -140, -130, 280, 260, 10, 9);
  truss(c, [-100, -120], [100, -120], 20, STEEL, 12);
  for (const s of [-1, 1]) {
    const x = s * 116;
    const drum = core(c, chamferBox(x - 20, -74, 40, 148, 10), 0x37332e, 24, Math.PI / 2);
    for (const y of [-56, 0, 56]) weld(c, [x - 17, y], [x + 17, y]);
    rivets(c, [x - 14, 66], [x + 14, 66], 7, 1.8);
    wornStripe(c, drum, Math.PI / 2, 30, 8, 80 + s);
    poly(c, ngon(x, -80, 9, 8, Math.PI / 8), SLAB_LIGHT, 'metal', 28, 1.5);
    strut(c, [x, -84], [s * 96, -112], 9, 14);
    strut(c, [s * 79, sy], [s * 97, sy], 12, 16);
  }
  const ring = core(c, ngon(sx, sy, 80, 16, Math.PI / 16), SLAB_LIGHT, 26, Math.PI / 2);
  wornStripe(c, ring, Math.PI / 2, sy - 70, 8, 70);
  for (let i = 0; i < 16; i += 2) {
    const a = (i * Math.PI) / 8, b = a + Math.PI / 8, r = 70;
    rivets(c, [sx + Math.cos(a) * r, sy + Math.sin(a) * r], [sx + Math.cos(b) * r, sy + Math.sin(b) * r], 12, 1.8);
  }
  poly(c, ngon(sx, sy, 58, 16, Math.PI / 16), SOOT, 'metal', -10, 4);
  poly(c, ngon(sx, sy, 42, 16, Math.PI / 16), SLAB_DARK, 'metal', -6, 3);
  poly(c, ngon(sx, sy, 27, 16, Math.PI / 16), SOOT, 'metal', -4, 2);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6 + 0.18;
    const ca = Math.cos(a), sa = Math.sin(a);
    poly(c, strip([sx + ca * 22, sy + sa * 22], [sx + ca * 56, sy + sa * 56], 3.2), STEEL, 'metal', 3, 0.8);
  }
  poly(c, ngon(sx, sy, 16, 8, Math.PI / 8), SLAB, 'metal', 6, 1.5);
  // Bottle rack: a base plate, hazard ends, five pressure bottles.
  core(c, chamferBox(-84, 94, 168, 44, 8), SLAB_DARK, 10, 0);
  for (const s of [-1, 1]) poly(c, chamferBox(s > 0 ? 70 : -84, 96, 14, 40, 3), HAZARD, 'hazard', 1, 0.5);
  for (let i = 0; i < 5; i++) {
    const x = -60 + i * 30;
    poly(c, ngon(x, 112, 13, 10), 0x433a30, 'metal', 18, 3, { roof: [3, 4] });
    poly(c, ngon(x, 112, 4, 6), RIVET, 'metal', 4, 1);
  }
  poly(c, strip([-74, 100], [74, 100], 2.4), STEEL, 'metal', 20, 0.6);
  bakeSlits(c, GAS_SLITS);
  scaffold(c, 92, 44, 48, 48, 16, 12);
  stencil(c, '34', -124, 84, 22);
  if (c.livery) c.sigils.push({ x: 116, y: 12, r: 12 });
  lamp(c, sx, sy - 88, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 130, -84, 3.5, LAMP_AMBER);
}

// ── Research lab (400 × 300) ────────────────────────────────────────────────

/** The observatory dome's centre. */
const DOME: Pt = [64, -6];

/** The research lab's work-glow slits (x, y, w, h in px, the drawer's frame):
 *  one in each lab module, one up the link module, one on the sensor head in
 *  the dome's shutter slot, one on the dome's base ring. */
export const LAB_SLITS: ReadonlyArray<WorkSlit> = [
  [-160, -52, 40, 4], [-160, 100, 40, 4], [-63, -18, 4, 36], [62, -54, 4, 20], [50, 68, 28, 4],
];

/** The starved lab's no-supply mark: on the lower lab module's open roof,
 *  above its slit, clear of the trusses. */
export const LAB_MARK: WorkMark = [-136, 72, 13, 3];

/** A yagi antenna mast at (x, y): a tall base post, a boom `half` either side
 *  and five cross elements. */
function mast(c: StyleCtx, x: number, y: number, half: number): void {
  poly(c, ngon(x, y, 10, 8, Math.PI / 8), SLAB_DARK, 'metal', 30, 2);
  poly(c, strip([x - half, y], [x + half, y], 3), STEEL, 'metal', 34, 0.8);
  for (let i = 0; i < 5; i++) {
    const ex = x - half + 4 + (i * (2 * half - 8)) / 4, el = 11 - i * 1.2;
    poly(c, strip([ex, y - el], [ex, y + el], 2.4), RIVET, 'metal', 35, 0.6);
  }
}

/** Research lab: a faceted observatory dome on a riveted base ring, its
 *  shutter slot open over a sensor head; two lab modules on a walkway spine
 *  and a link module on the left; a yagi mast on each side, a sensor dish,
 *  a pipe-rack truss along the bottom, a scaffold up the dome's flank. */
function researchLab(c: StyleCtx): void {
  const [dx, dy] = DOME;
  deck(c);
  grime(c, -190, -140, 380, 280, 12, 11);
  truss(c, [-80, 124], [40, 124], 20, STEEL, 10);
  walkway(c, [-136, -40], [-136, 40], 18);
  for (const s of [-1, 1]) {
    const y0 = s < 0 ? -120 : 36;
    const mod = core(c, chamferBox(-180, y0, 88, 84, 14), SLAB, 26, 0);
    rivets(c, [-170, y0 + 8], [-102, y0 + 8], 12);
    weld(c, [-176, y0 + 42], [-96, y0 + 42]);
    wornStripe(c, mod, 0, -100, 6, 90 + s);
    poly(c, chamferBox(-146, s < 0 ? -40 : 34, 20, 6, 1.5), HAZARD, 'hazard', 1, 0.5);
  }
  core(c, chamferBox(-84, -30, 46, 60, 10), SLAB_DARK, 18, Math.PI / 2);
  strut(c, [-127, 0], [-84, 0], 10, 14);
  strut(c, [-38, 14], [-24, 14], 10, 14);
  // Sensor dish: a rim, a dark bowl, a tripod feed.
  poly(c, ngon(-50, 80, 28, 16), SLAB_LIGHT, 'metal', 14, 2);
  poly(c, ngon(-50, 80, 22, 16), SOOT, 'metal', -3, 2.5);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
    poly(c, strip([-50 + Math.cos(a) * 22, 80 + Math.sin(a) * 22], [-50, 80], 2), STEEL, 'metal', 6, 0.5);
  }
  poly(c, ngon(-50, 80, 4, 6), RIVET, 'metal', 8, 1);
  // Observatory dome: base ring, faceted inner dome, cap, open shutter slot.
  const base = core(c, ngon(dx, dy, 96, 20, Math.PI / 20), SLAB, 22, Math.PI / 2);
  for (let i = 0; i < 20; i += 2) {
    const a = (i * Math.PI) / 10, b = a + Math.PI / 10, r = 87;
    rivets(c, [dx + Math.cos(a) * r, dy + Math.sin(a) * r], [dx + Math.cos(b) * r, dy + Math.sin(b) * r], 12, 1.8);
  }
  wornStripe(c, base, Math.PI / 2, dy - 84, 7, 95);
  core(c, ngon(dx, dy, 74, 20, Math.PI / 20), SLAB_LIGHT, 10, 0);
  poly(c, ngon(dx, dy, 40, 20, Math.PI / 20), 0x45484b, 'metal', 6, 2, { roof: [3, 10] });
  for (const s of [-1, 1]) poly(c, strip([dx + s * 12, dy + 10], [dx + s * 12, dy - 78], 2.4), STEEL, 'metal', 4, 0.6);
  poly(c, strip([dx, dy + 6], [dx, dy - 80], 18), SOOT, 'metal', -2, 1.5);
  poly(c, chamferBox(dx - 7, -58, 14, 30, 3), SLAB_DARK, 'metal', 6, 1);
  bakeSlits(c, LAB_SLITS);
  scaffold(c, -30, -60, 28, 100, 14, 12);
  mast(c, -46, -100, 30);
  mast(c, 148, -112, 20);
  stencil(c, '58', 110, 100, 22);
  if (c.livery) c.sigils.push({ x: -136, y: -82, r: 16 });
  lamp(c, -46, -100, 3.5, LAMP_WHITE);
  lamp(c, 148, -112, 3.5, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, -172, s * 112, 3.5, LAMP_AMBER);
  lamp(c, 150, 90, 3.5, LAMP_AMBER);
}

// ── Tables (spread into the family's, structureStyleC.lightProduction.ts) ──

/** Live work glow: lit only while working, red mark when starved. */
export const status: BodyStatusHookTable = {
  gas_collector: workGlowStatus(GAS_SLITS, GAS_MARK),
  research_lab: workGlowStatus(LAB_SLITS, LAB_MARK),
};

/** Style C drawers. */
export const kinds: StyleDrawerTable = {
  gas_collector: gasCollector,
  research_lab: researchLab,
};
