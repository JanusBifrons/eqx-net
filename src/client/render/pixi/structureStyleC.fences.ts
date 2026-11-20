/**
 * Style C family "fences" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Fences + gates: shield pylon, shield gate, airlock, territory lock.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import {
  LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, glow, lamp,
  ngon, poly, rivets, stencil, strip, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f2lk';

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

/** Territory Lock (drawn for 400 × 300, scaled by the short side / 300):
 *  the broadcast SPIRE in style C. A long riveted spine runs the full width;
 *  three pairs of antenna fins either side, tapering toward the ends, each
 *  tipped with claim-teal emitter heads; a chamfered lantern tower in the
 *  middle with lit slots above and below a round beacon seat. The beacon (a
 *  dish on a sweep arm) is drawn static here: the client does not yet know
 *  whether the lock holds its sector, so it cannot turn only while holding. */
function territoryLock(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W / 400, H / 300);
  const emit = c.live ? EMIT : EMIT_DEAD;
  deck(c);
  // The spine: a dark beam, a lighter cap plate, rivet rows both edges.
  const half = W / 2 - 14 * k;
  core(c, chamferBox(-half, -22 * k, 2 * half, 44 * k, 10 * k), SLAB_DARK, 12, 0);
  poly(c, chamferBox(-half + 10 * k, -8 * k, 2 * half - 20 * k, 16 * k, 4 * k), SLAB_LIGHT, 'metal', 3, 1);
  for (const s of [-1, 1]) rivets(c, [-half + 14 * k, s * 15 * k], [half - 14 * k, s * 15 * k], 14 * k, 1.8 * k);
  // Antenna fins: three pairs either side of the tower.
  const fins = [[98, 118], [136, 96], [172, 72]] as const;
  for (const [fx, fl] of fins) {
    for (const sx of [-1, 1]) {
      const cx = sx * fx * k, len = fl * k;
      poly(c, chamferBox(cx - 8 * k, -len, 16 * k, 2 * len, 5 * k), SLAB, 'metal', 14, 2, { seams: 18 * k, seamAngle: 0 });
      poly(c, strip([cx, -len + 14 * k], [cx, len - 14 * k], 3 * k), SOOT, 'metal', -1, 0.6);
      for (const sy of [-1, 1]) {
        poly(c, chamferBox(cx - 11 * k, sy * len - (sy > 0 ? 12 * k : 0), 22 * k, 12 * k, 3 * k), SLAB_LIGHT, 'metal', 18, 1.2);
        glow(c, ngon(cx, sy * (len - 6 * k), 4 * k, 8), emit, 0.95);
      }
    }
  }
  // The lantern tower.
  const tw = 60 * k, th = 128 * k;
  const tower = core(c, chamferBox(-tw, -th, 2 * tw, 2 * th, 22 * k), SLAB, 22, Math.PI / 2);
  wornStripe(c, tower, Math.PI / 2, -th + 14 * k, 7 * k, 11);
  for (const sy of [-1, 1]) {
    poly(c, chamferBox(-14 * k, sy > 0 ? 66 * k : -108 * k, 28 * k, 42 * k, 5 * k), SOOT, 'metal', -2, 1.5);
    glow(c, chamferBox(-8 * k, sy > 0 ? 72 * k : -102 * k, 16 * k, 30 * k, 3 * k), emit, 0.9);
  }
  // The beacon seat: collar, bolt ring, dark well.
  poly(c, ngon(0, 0, 50 * k, 24), SLAB_DARK, 'metal', 26, 2);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    poly(c, ngon(Math.cos(a) * 45 * k, Math.sin(a) * 45 * k, 1.7 * k, 6), RIVET, 'metal', 28, 0.5);
  }
  poly(c, ngon(0, 0, 40 * k, 24), SOOT, 'metal', 22, 1.5);
  // The beacon (static for now): a sweep arm with a dish, its counterweight,
  // and the claim-teal emitter on the hub.
  poly(c, strip([-22 * k, 0], [30 * k, 0], 8 * k), SLAB_LIGHT, 'metal', 30, 1);
  poly(c, chamferBox(-30 * k, -9 * k, 12 * k, 18 * k, 3 * k), SLAB, 'metal', 31, 1);
  poly(c, [[24 * k, -20 * k], [34 * k, -14 * k], [36 * k, 0], [34 * k, 14 * k], [24 * k, 20 * k], [28 * k, 0]], SLAB_LIGHT, 'metal', 32, 1.2);
  poly(c, ngon(0, 0, 11 * k, 12), SLAB, 'metal', 33, 1);
  glow(c, ngon(0, 0, 6 * k, 12), emit, 0.95);
  c.lit(0, 0, 6 * k, c.live ? 0xd8fbff : EMIT_DEAD);
  // Spine-end hazard lamps, tower work lamps, a hull number.
  for (const sx of [-1, 1]) lamp(c, sx * (half - 8 * k), 0, 4 * k, LAMP_AMBER);
  lamp(c, -tw + 10 * k, th - 12 * k, 3 * k, LAMP_WHITE);
  lamp(c, tw - 10 * k, -th + 12 * k, 3 * k, LAMP_AMBER);
  stencil(c, '01', 16 * k, 46 * k, 18 * k);
  if (c.livery) c.sigils.push({ x: -36 * k, y: 60 * k, r: 12 * k });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  shield_pylon: shieldPylon,
  territory_lock: territoryLock,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {};
