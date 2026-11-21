/**
 * Style C family "mining" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Mining: miner, deep core rig.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, core, deck, glow,
  grime, lamp, ngon, poly, rivets, stencil, strip, truss, weld, wornStripe, type Pt, type StyleCtx,
  type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = '1';

/** Drill-ring emitter colour (lit, powered) and its dead glass (dark). */
const DRILL_LIT = 0x6fe2f0;
const DRILL_DEAD = 0x16262a;
/** The ore throat's work glow (lit) and its dead glass (dark). */
const THROAT_LIT = 0xffa040;
const THROAT_DEAD = 0x2a1a10;

/** Mining tower (`miner`, drawn for 240 × 240, scaled by the short side): a
 *  squat octagonal drill tower on four diagonal outrigger legs with foot
 *  pads. Its hero is the drill head on top: a toothed slewing ring with a
 *  teal-lit ring and a three-cone cutter bit at the hub (the drill mount
 *  turns over it). An ore intake hopper with a hazard rim and an amber
 *  throat feeds it from the -y side; a discharge chute runs to an ore bin on
 *  the +y side; power couplings sit on the ±x sides (sockets stay clear on
 *  each side's middle). Unpowered, the ring and throat go dark. */
function miner(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 240;
  const live = c.live;
  deck(c);
  grime(c, -100 * k, -100 * k, 200 * k, 200 * k, 10, 4);
  // Outrigger legs on the diagonals, each ending in a bolted foot pad.
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    truss(c, [sx * 44 * k, sy * 44 * k], [sx * 76 * k, sy * 76 * k], 16 * k, STEEL, 10);
    poly(c, chamferBox(sx * 80 * k - 12 * k, sy * 80 * k - 12 * k, 24 * k, 24 * k, 6 * k), SLAB_LIGHT, 'metal', 12, 1.5);
    poly(c, ngon(sx * 80 * k, sy * 80 * k, 5 * k, 6), RIVET, 'metal', 14, 0.6);
  }
  // Power couplings on the ±x sides: a dark conduit box and a status pip.
  for (const s of [-1, 1]) {
    poly(c, chamferBox(s > 0 ? 62 * k : -100 * k, -14 * k, 38 * k, 28 * k, 6 * k), SLAB_DARK, 'metal', 10, 1.5, { seams: 7 * k, seamAngle: Math.PI / 2 });
    glow(c, chamferBox(s * 88 * k - 3 * k, -3 * k, 6 * k, 6 * k, 1.5 * k), live ? DRILL_LIT : DRILL_DEAD, 0.85);
  }
  // Ore bin on +y, fed by a discharge chute from the tower.
  poly(c, strip([0, 56 * k], [0, 72 * k], 18 * k), STEEL, 'metal', 14, 1.2);
  const bin = core(c, chamferBox(-34 * k, 70 * k, 68 * k, 32 * k, 9 * k), SLAB, 16, Math.PI / 2);
  poly(c, chamferBox(-24 * k, 76 * k, 48 * k, 18 * k, 5 * k), SOOT, 'metal', -3, 1.5);
  wornStripe(c, bin, Math.PI / 2, 98 * k, 5 * k, 9);
  // Ore intake hopper on -y: a hazard-rimmed box, sloping dark faces, and
  // the throat (an amber work glow down the chute when powered).
  core(c, chamferBox(-38 * k, -104 * k, 76 * k, 44 * k, 10 * k), SLAB_LIGHT, 20, 0);
  for (const s of [-1, 1]) poly(c, strip([s * 30 * k, -98 * k], [s * 30 * k, -66 * k], 5 * k), HAZARD, 'hazard', 2, 0.6);
  poly(c, chamferBox(-26 * k, -96 * k, 52 * k, 28 * k, 8 * k), SLAB_DARK, 'metal', -4, 3);
  poly(c, chamferBox(-14 * k, -88 * k, 28 * k, 14 * k, 4 * k), SOOT, 'metal', -3, 1.5);
  glow(c, chamferBox(-10 * k, -84 * k, 20 * k, 6 * k, 2 * k), live ? THROAT_LIT : THROAT_DEAD, 0.8);
  rivets(c, [-30 * k, -101 * k], [30 * k, -101 * k], 10 * k, 1.8 * k);
  // The tower: an octagonal slab with a bolt ring and a worn accent band.
  const tower = core(c, ngon(0, 0, 64 * k, 8, Math.PI / 8), SLAB, 26, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, b = a + Math.PI / 4, r = 56 * k;
    rivets(c, [Math.cos(a) * r, Math.sin(a) * r], [Math.cos(b) * r, Math.sin(b) * r], 11 * k, 1.8 * k);
  }
  wornStripe(c, tower, Math.PI / 2, 46 * k, 7 * k, 17);
  weld(c, [-40 * k, -46 * k], [40 * k, -46 * k]);
  // The drill head: a toothed slewing ring, a teal-lit ring, and a
  // three-cone cutter bit round the hub.
  poly(c, ngon(0, 0, 46 * k, 24), SLAB_DARK, 'metal', 30, 2);
  for (let i = 0; i < 24; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / 24;
    const p = (r: number): Pt => [Math.cos(a) * r, Math.sin(a) * r];
    poly(c, strip(p(44 * k), p(50 * k), 4 * k), STEEL, 'metal', 31, 0.6);
  }
  poly(c, ngon(0, 0, 38 * k, 24), SOOT, 'metal', 28, 1.5);
  const ring = live ? DRILL_LIT : DRILL_DEAD;
  for (let i = 0; i < 12; i++) {
    const a0 = (i * Math.PI * 2) / 12 + 0.06, a1 = ((i + 1) * Math.PI * 2) / 12 - 0.06;
    const q = (a: number, r: number): Pt => [Math.cos(a) * r * k, Math.sin(a) * r * k];
    glow(c, [q(a0, 31), q(a1, 31), q(a1, 35), q(a0, 35)], ring, 0.9);
  }
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3, cx = Math.cos(a) * 15 * k, cy = Math.sin(a) * 15 * k;
    poly(c, ngon(cx, cy, 11 * k, 8), SLAB_LIGHT, 'metal', 34, 1.5);
    for (let t = 0; t < 4; t++) {
      const b = a + (t * Math.PI) / 2;
      poly(c, ngon(cx + Math.cos(b) * 6 * k, cy + Math.sin(b) * 6 * k, 2.2 * k, 3, b), RIVET, 'metal', 36, 0.5);
    }
  }
  poly(c, ngon(0, 0, 7 * k, 8), SLAB, 'metal', 38, 1);
  c.lit(0, 0, 5 * k, live ? 0xd8fbff : DRILL_DEAD);
  // Work lamps on two legs, a hull number on the bin, the owner's sigil.
  lamp(c, -80 * k, -80 * k, 3.5 * k, LAMP_AMBER);
  lamp(c, 80 * k, 80 * k, 3.5 * k, LAMP_WHITE);
  stencil(c, '14', -12 * k, 79 * k, 12 * k);
  if (c.livery) c.sigils.push({ x: -40 * k, y: 30 * k, r: 7 * k });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  miner,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
