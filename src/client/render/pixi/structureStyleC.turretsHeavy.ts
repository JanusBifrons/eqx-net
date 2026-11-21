/**
 * Style C turrets family, the two heavy defences (docs/plans/structure-
 * restyle-stage4.md §6): the missile turret and the mine layer. Part of the
 * turrets family: `kinds` and `version` are spread into that family's file
 * (structureStyleC.turrets.ts), which is what `STYLE_C` assembles. Both stand
 * on the family's shared gun pad (structureStyleC.turrets.pad.ts).
 *
 * Only the BASE is drawn. The missile launcher (ring = R × 0.4 × 1.3, R = half
 * the short side, `turretLayout.ts`) turns in a dark well drawn last by the
 * pad; nothing after it comes inside that ring. The mine layer has no mount:
 * its mines fly on a ring round it (shared-types/mines.ts), so its middle is
 * only the launch tube's dark mouth.
 */
import {
  HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, deck, glow, lamp, ngon, poly,
  rivets, stencil, strip, type Pt, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import { TRIM_DEAD, gunPad } from './structureStyleC.turrets.pad.js';
import type { GraphicsContext } from 'pixi.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';

/** Bump with any change to these drawings; it rides the turrets family's
 *  version (structureStyleC.turrets.ts), so their bake keys move on. */
export const version = 'h1';

/** The missile turret's well, × R: its launcher ring is R × 0.52, so the well
 *  is wider than the small guns' (0.5) to keep a dark lip round it. */
export const MISSILE_WELL = 0.56;

/** The mine layer's launch tube mouth (× R) and its six mine racks: centred
 *  on a ring of RACK_R × R, one every 60°. */
export const TUBE_R = 0.3;
export const RACK_R = 0.66;
export const RACKS = 6;

/** One lamp socket per mine rack, at its outer end: local coords × R (R =
 *  half the short side, 110 px for the 220 × 220 mine layer; +y is down, as
 *  in the drawers). Baked as dead glass; the live overlay (`status`) lights
 *  one per mine out from the layer's row (`minesOut`). Rack k's socket is
 *  entry k. */
export const MINE_LAMP_R = 0.785;
export const MINE_LAMP_SOCKETS: readonly Pt[] = Array.from({ length: RACKS }, (_, k) => {
  const a = (k * 2 * Math.PI) / RACKS;
  return [Math.cos(a) * MINE_LAMP_R, Math.sin(a) * MINE_LAMP_R] as const;
});

/** A box `r0..r1` out along angle `a`, `hw` either side (all in px). */
function radialBox(a: number, r0: number, r1: number, hw: number): Pt[] {
  const cx = Math.cos(a), cy = Math.sin(a), tx = -cy, ty = cx;
  return [
    [cx * r0 + tx * hw, cy * r0 + ty * hw], [cx * r1 + tx * hw, cy * r1 + ty * hw],
    [cx * r1 - tx * hw, cy * r1 - ty * hw], [cx * r0 - tx * hw, cy * r0 - ty * hw],
  ];
}

/** Missile turret (`missile_turret`, 190 × 190, hex outline): the big missile
 *  emplacement. A low hex armour skirt with seams under a wide gun pad (wider
 *  well for the launcher), blast-vent grilles at both pointed ends, a
 *  magazine hatch on +y with a hazard edge, stencil and work lamps on −y. */
function missileTurret(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  // The reinforced skirt, following the hex.
  poly(c, ngon(0, 0, 0.95 * R, 6), SLAB_DARK, 'metal', 10, 0.08 * R, { seams: 0.18 * R, seamAngle: Math.PI / 2 });
  gunPad(c, R, 0.86, 41, MISSILE_WELL);
  // Everything below stays outside the launcher ring (≥ 0.64 R).
  // Blast vents: a sooty recess with three slats, at each pointed end.
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? 0.79 * R : -0.91 * R, w = 0.12 * R;
    poly(c, chamferBox(x0, -0.13 * R, w, 0.26 * R, 0.03 * R), SOOT, 'metal', -2, 1);
    for (const dy of [-0.07, 0, 0.07]) {
      poly(c, strip([x0 + 0.015 * R, dy * R], [x0 + w - 0.015 * R, dy * R], 0.025 * R), STEEL, 'metal', 14, 0.4);
    }
  }
  // Magazine hatch on +y: an outlined plate, two lift lugs, a hazard edge
  // (kept inside 0.78 R, clear of the +y cable socket stud).
  poly(c, chamferBox(-0.23 * R, 0.65 * R, 0.46 * R, 0.11 * R, 0.03 * R), SOOT, 'metal', 22, 0.6);
  poly(c, chamferBox(-0.2 * R, 0.665 * R, 0.4 * R, 0.075 * R, 0.02 * R), SLAB_LIGHT, 'metal', 24, 0.8);
  for (const s of [-1, 1]) poly(c, ngon(s * 0.12 * R, 0.7 * R, 0.02 * R, 6), RIVET, 'metal', 26, 0.5);
  poly(c, chamferBox(-0.22 * R, 0.74 * R, 0.44 * R, 0.03 * R, 0.01 * R), HAZARD, 'hazard', 12, 0.5);
  // Rivet rows along the skirt's slanted faces on −y.
  for (const s of [-1, 1]) rivets(c, [s * 0.8 * R, -0.22 * R], [s * 0.6 * R, -0.58 * R], 0.1 * R, 0.02 * R);
  for (const s of [-1, 1]) lamp(c, s * 0.55 * R, -0.62 * R, 0.035 * R, LAMP_WHITE);
  stencil(c, '19', -0.14 * R, -0.8 * R, 0.1 * R);
  if (c.livery) c.sigils.push({ x: -0.5 * R, y: 0.5 * R, r: 0.08 * R });
}

/** Mine layer (`mine_layer`, 220 × 220): a squat armoured launcher, not a
 *  gun. The family pad round a wide launch tube (dark mouth, steel rim), and
 *  six mine racks on a ring round it, each a cradle holding a stowed mine,
 *  railed in from the collar, with a mine lamp socket (baked dead glass, lit
 *  per mine out by the live overlay, `MINE_LAMP_SOCKETS`). */
function mineLayer(c: StyleCtx): void {
  const R = Math.min(c.W, c.H) / 2;
  deck(c);
  gunPad(c, R, 0.9, 51, TUBE_R);
  // The tube: a deeper mouth inside the well and a steel rim round it.
  poly(c, ngon(0, 0, 0.21 * R, 16), SOOT, 'metal', -6, 0.04 * R);
  for (let i = 0; i < 16; i++) {
    const a0 = (i * Math.PI) / 8, a1 = a0 + Math.PI / 10, rr = (TUBE_R + 0.01) * R;
    poly(c, strip([Math.cos(a0) * rr, Math.sin(a0) * rr], [Math.cos(a1) * rr, Math.sin(a1) * rr], 0.025 * R), STEEL, 'metal', 20, 0.4);
  }
  // The six racks.
  for (let k = 0; k < RACKS; k++) {
    const a = (k * 2 * Math.PI) / RACKS;
    const mx = Math.cos(a) * RACK_R * R, my = Math.sin(a) * RACK_R * R;
    poly(c, strip([Math.cos(a) * 0.46 * R, Math.sin(a) * 0.46 * R], [Math.cos(a) * 0.58 * R, Math.sin(a) * 0.58 * R], 0.035 * R), STEEL, 'metal', 22, 0.5);
    poly(c, radialBox(a, (RACK_R - 0.09) * R, (RACK_R + 0.09) * R, 0.1 * R), SLAB_LIGHT, 'metal', 28, 0.04 * R);
    poly(c, radialBox(a, (RACK_R - 0.07) * R, (RACK_R + 0.07) * R, 0.075 * R), SOOT, 'metal', 26, 0.5);
    poly(c, ngon(mx, my, 0.055 * R, 8, Math.PI / 8), SLAB_DARK, 'metal', 30, 0.02 * R);
    poly(c, ngon(mx, my, 0.018 * R, 6), RIVET, 'metal', 32, 0.4);
    const [lx, ly] = MINE_LAMP_SOCKETS[k]!;
    poly(c, ngon(lx * R, ly * R, 0.042 * R, 8), SOOT, 'metal', 24, 0.4);
    glow(c, ngon(lx * R, ly * R, 0.028 * R, 8), TRIM_DEAD, 0.9);
  }
  stencil(c, '22', 0.5 * R, -0.9 * R, 0.12 * R);
  if (c.livery) c.sigils.push({ x: -0.72 * R, y: 0.72 * R, r: 0.09 * R });
}

// ── Live mine lamps (BodyStatusHook) ────────────────────────────────────────

/** A lit lamp: the warm work-lamp amber (`LAMP_AMBER`) with a hot white core
 *  (`LAMP_WHITE`) and a soft halo round the socket. */
const _fill = { color: 0, alpha: 0 };

/** How many rack lamps are lit: the layer's mines out, on a built layer. */
function mineLampCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  if (st === undefined || !st.built) return 0;
  return Math.min(RACKS, Math.max(0, st.minesOut ?? 0));
}

/** Light the first `code` lamp sockets (rack 0 first). */
function drawMineLamps(g: GraphicsContext, code: number, kind: StructureKindId): void {
  const fp = getStructureKind(kind).footprint;
  const R = Math.min(fp.w, fp.h) / 2;
  for (let k = 0; k < code && k < RACKS; k++) {
    const [lx, ly] = MINE_LAMP_SOCKETS[k]!;
    const x = lx * R, y = ly * R;
    g.circle(x, y, 0.06 * R); _fill.color = LAMP_AMBER; _fill.alpha = 0.22; g.fill(_fill);
    g.circle(x, y, 0.03 * R); _fill.color = LAMP_AMBER; _fill.alpha = 0.95; g.fill(_fill);
    g.circle(x, y, 0.013 * R); _fill.color = LAMP_WHITE; _fill.alpha = 0.9; g.fill(_fill);
  }
}

const mineLampStatus: BodyStatusHook = { code: mineLampCode, draw: drawMineLamps };

/** The heavy defences' live body state (`BodyStatusHook`, drawn on the
 *  socket-nub overlay, structureSocketNubs.ts): a lamp per mine out. */
export const status: BodyStatusHookTable = {
  mine_layer: mineLampStatus,
};

/** The heavy defences' style C drawers. */
export const kinds: StyleDrawerTable = {
  missile_turret: missileTurret,
  mine_layer: mineLayer,
};
