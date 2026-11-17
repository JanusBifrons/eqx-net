/**
 * Structure style A, "faceted industrial" (docs/plans/structure-restyle.md §4,
 * slice 1d): hex and chamfered plates on the kind's outline
 * (`structureOutline`), faceted roofs, panel lines, hazard paint, lit trims
 * and signs (no sky-facing windows), owner livery bands and sigil slots.
 * Drawn into the ordinary structure draw plan; the forge bakes it.
 */
import {
  chamferBox, chevron, clipY, edgeTrim, mixColor, ngon, outlinePx, polyBounds, reach, scalePts, strip,
  type PolyOp, type Pts, type StructureStyleDef, type StyleCtx,
} from './structureStyleKit.js';

const STEEL = 0x6b7a8f;
const STEEL_DARK = 0x3c4656;
const STEEL_LIGHT = 0x9aa8bb;
const DECK = 0x1d2433;
const WARM = 0xffd27a;
const RED = 0xff4d5e;
const GREEN = 0x7fe0a4;
const SIGN_GLASS = 0x15303a;
const CRANE = 0xd8a93a;
const VENT = 0x1a1f28;

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function poly(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], lift: number, bevel: number, extra?: Partial<PolyOp>): void {
  c.polys.push({ pts, color, mat, lift, bevel, ...extra });
}
function glow(c: StyleCtx, pts: Pts, color: number, alpha = 1): void {
  poly(c, pts, color, 'glow', -0.8, 1, { alpha });
}
function band(c: StyleCtx, pts: Pts): void {
  if (c.livery) c.bands.push({ ...polyBounds(pts), pts });
}

/** Plinth on the outline, an optional hazard ring, and the main faceted
 *  plate. Returns the plate outline. */
function hull(c: StyleCtx, hazardRing: boolean, seamAngle: number, plateK = 0.9): Pts {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 3, 2);
  if (hazardRing) poly(c, scalePts(out, 0.97), 0xe8c547, 'hazard', 1, 1);
  const plate = scalePts(out, plateK);
  poly(c, plate, STEEL_DARK, 'metal', 10, 4, { roof: [4, Math.min(c.W, c.H) * 0.1], seams: 26, seamAngle });
  return plate;
}

/** Lit trims (in place of windows) along every other edge of `pts`. */
function trims(c: StyleCtx, pts: Pts, first: number, color = WARM): void {
  for (let i = first; i < pts.length; i += 2) glow(c, edgeTrim(pts, i, 0.3, 0.7, 5, 3), color, 0.7);
}

/** The beacon (the capital restyled): a hex tower carrying the owner's big
 *  sigil screen, six buttresses, beacon lamps at alternate tips. */
function beacon(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 3, 2);
  const ring = scalePts(out, 0.93);
  poly(c, ring, STEEL_DARK, 'metal', 10, 4, { roof: [4, 30], seams: 24, seamAngle: Math.PI / 6 });
  for (let k = 0; k < 6; k++) {
    const a = k * (Math.PI / 3) + Math.PI / 6;
    const R = 0.86 * reach(out, a);
    const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
    const at = (r: number, w: number): readonly [number, number] => [ux * r + nx * w, uy * r + ny * w];
    const but = [at(118, -36), at(R, -22), at(R, 22), at(118, 36)];
    poly(c, but, STEEL, 'metal', 16, 4, { roof: [6, 14] });
    // Lit trim across the tip; beacon lamps on alternate tips.
    glow(c, [at(R - 16, -16), at(R - 10, -16), at(R - 10, 16), at(R - 16, 16)], 0x7cf7ff, 0.7);
    if (k % 2 === 1) c.lit(ux * (R - 26), uy * (R - 26), 9, RED);
    else band(c, [at(140, -10), at(R - 30, -8), at(R - 30, 8), at(140, 10)]);
  }
  poly(c, ngon(0, 0, 128, 6), STEEL_LIGHT, 'metal', 22, 5, { roof: [8, 20] });
  poly(c, ngon(0, 0, 112, 6), mixColor(c.accent, STEEL_DARK, 0.5), 'paint', 2, 2);
  glow(c, ngon(0, 0, 100, 6), mixColor(c.accent, 0x0a1420, 0.6), 0.8);
  if (c.livery) c.sigils.push({ x: 0, y: 0, r: 84, screen: true });
  else c.lit(0, 0, 26, c.accent);
}

/** Hex line node: a hexagon pylon with a lit core. */
function hexNode(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 3, 1.5);
  poly(c, scalePts(out, 0.8), STEEL, 'metal', 8, 2, { roof: [4, 8] });
  // Clamp lugs where the lines attach (alternate faces).
  for (let k = 0; k < 6; k += 2) {
    const a = k * (Math.PI / 3);
    poly(c, strip([Math.cos(a) * 14, Math.sin(a) * 14], [Math.cos(a) * 24, Math.sin(a) * 24], 8), STEEL_LIGHT, 'metal', 4, 1);
  }
  glow(c, ngon(0, 0, 9, 6), mixColor(c.accent, 0xffffff, 0.2), 1);
  band(c, strip([-10, -19], [10, -19], 5));
  c.lit(0, 0, 7, c.accent);
}

/** Medium dock (`freight_dock` evolved): a hazard-striped lip with chevron
 *  floor strips on the -y side, the dock house with a big lit in/out +
 *  cargo sign, and the loading crane folded along its roof. */
function dock(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  const hh = c.H / 2;
  const lipY = -hh + c.H * 0.4;
  poly(c, out, DECK, 'metal', 2, 2);
  // Lip (under layer): hazard apron, a dark bay floor, chevrons pointing in.
  poly(c, clipY(scalePts(out, 0.97), lipY - 6, false), 0xe8c547, 'hazard', 1, 1);
  poly(c, chamferBox(-200, -hh + 18, 400, c.H * 0.4 - 42, 10), 0x23293a, 'mark', 0.5, 1);
  for (const lx of [-110, 110]) {
    for (let k = 0; k < 3; k++) glow(c, chevron(lx, -hh + 32 + k * 21, 70, 16, 6, 1), GREEN, 0.75);
  }
  // Dock house.
  const house = chamferBox(-245, lipY + 2, 490, hh - lipY - 8, 30);
  poly(c, house, STEEL_DARK, 'metal', 18, 5, { roof: [6, 30], seams: 30, seamAngle: 0 });
  glow(c, edgeTrim(house, 0, 0.1, 0.9, 4, 3), WARM, 0.6);
  // The big lit sign: frame, glass, "in" arrow and the cargo (ore) icon.
  const sy = lipY + 20, sh = hh - lipY - 46;
  poly(c, chamferBox(-232, sy - 4, 188, sh + 8, 16), STEEL_LIGHT, 'metal', 4, 2);
  glow(c, chamferBox(-228, sy, 180, sh, 14), SIGN_GLASS, 1);
  glow(c, chevron(-180, sy + sh / 2, 50, 40, 12, 1), GREEN, 1.2);
  glow(c, ngon(-95, sy + sh / 2, 24, 6), WARM, 1.1);
  glow(c, ngon(-95, sy + sh / 2, 11, 6), SIGN_GLASS, 1);
  // Folded crane: pivot, counter-jib, boom with truss marks, hook block.
  const py = lipY + 46;
  poly(c, strip([196, py], [234, py], 18), STEEL, 'metal', 26, 2);
  poly(c, ngon(196, py, 24, 6), STEEL_LIGHT, 'metal', 28, 3, { roof: [4, 8] });
  poly(c, strip([186, py - 14], [-34, lipY + 12], 16), CRANE, 'paint', 30, 2);
  for (let t = 0.08; t < 0.95; t += 0.1) {
    const x = 186 + (-34 - 186) * t, y = py - 14 + (lipY + 12 - (py - 14)) * t;
    poly(c, strip([x - 3, y], [x + 3, y], 12), mixColor(CRANE, 0x000000, 0.45), 'mark', 0, 0.5);
  }
  poly(c, chamferBox(-48, lipY + 3, 18, 18, 4), STEEL_LIGHT, 'metal', 4, 1);
  c.lit(196, py, 6, WARM);
  // Livery: a band along the house's base, the emblem beside the sign.
  band(c, chamferBox(-200, hh - 30, 400, 10, 4));
  if (c.livery) c.sigils.push({ x: 40, y: (lipY + hh) / 2 + 16, r: 32 });
  c.lit(-228, -hh + 20, 7, GREEN);
  c.lit(228, -hh + 20, 7, GREEN);
}

/** Power station (`reactor`): an octagonal containment core with a glowing
 *  port, four hex coolant towers on conduits. */
function powerStation(c: StyleCtx): void {
  const plate = hull(c, true, Math.PI / 4);
  const d = 118;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    poly(c, strip([0, 0], [sx * d, sy * d], 26), STEEL, 'metal', 12, 3);
  }
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    poly(c, ngon(sx * d, sy * d, 44, 6), STEEL_LIGHT, 'metal', 28, 4, { roof: [10, 22] });
    poly(c, ngon(sx * d, sy * d, 20, 6), VENT, 'metal', -2, 2);
  }
  poly(c, ngon(0, 0, 118, 8, Math.PI / 8), STEEL, 'metal', 22, 5, { roof: [8, 40], seams: 22, seamAngle: 0 });
  glow(c, ngon(0, 0, 56, 6), c.live ? mixColor(c.accent, 0xffffff, 0.15) : 0x553322, 1);
  c.lit(0, 0, 30, c.live ? c.accent : 0x553322);
  trims(c, plate, 1);
  band(c, chamferBox(-172, -34, 30, 68, 8));
  band(c, chamferBox(142, -34, 30, 68, 8));
  if (c.livery) c.sigils.push({ x: 0, y: -150, r: 22 });
}

/** Cargo hold (`cargo_bay`): six chamfered, ribbed container bays on a spine. */
function cargoHold(c: StyleCtx): void {
  const plate = hull(c, true, 0);
  poly(c, chamferBox(-130, -6, 260, 12, 3), STEEL, 'metal', 6, 2);
  const tints = [0x3f8f92, 0xb9772f, 0x5a6e9a];
  let k = 0;
  for (const cy of [-44, 44]) {
    for (const cx of [-92, 0, 92]) {
      poly(c, chamferBox(cx - 39, cy - 32, 78, 64, 12), tints[hash(c.seed, k++) % 3]!, 'paint', 16, 3, { roof: [4, 10], seams: 10, seamAngle: 0 });
    }
  }
  trims(c, plate, 3);
  band(c, chamferBox(-142, -40, 8, 80, 3));
  band(c, chamferBox(134, -40, 8, 80, 3));
  if (c.livery) c.sigils.push({ x: 0, y: -44, r: 22 });
  c.lit(-140, 0, 6, WARM);
  c.lit(140, 0, 6, WARM);
}

/** Refinery: a tank farm of octagonal tanks (work-glow ports) piped into a
 *  tall hex cracking column that carries the emblem. */
function refinery(c: StyleCtx): void {
  hull(c, false, Math.PI / 3, 0.92);
  const col: readonly [number, number] = [92, 0];
  const tanks: Array<readonly [number, number]> = [[-70, -48], [-70, 46], [12, -56], [12, 50]];
  for (const t of tanks) poly(c, strip(t, col, 10), STEEL_LIGHT, 'metal', 6, 2);
  for (const [tx, ty] of tanks) {
    poly(c, ngon(tx, ty, 34, 8, Math.PI / 8), mixColor(c.accent, STEEL, 0.5), 'paint', 20, 4, { roof: [8, 16] });
    glow(c, ngon(tx, ty, 9, 6), 0xff9a3a, 1);
  }
  poly(c, ngon(col[0], col[1], 44, 6), STEEL_LIGHT, 'metal', 34, 5, { roof: [12, 26] });
  band(c, chamferBox(col[0] - 40, col[1] + 26, 80, 10, 4));
  if (c.livery) c.sigils.push({ x: col[0], y: col[1] - 4, r: 22 });
  else glow(c, ngon(col[0], col[1], 14, 6), 0xff9a3a, 0.9);
  c.lit(col[0], col[1] - 34, 7, RED);
}

/** Style A's drawer table: one entry per restyled kind. */
export const STYLE_A: StructureStyleDef = {
  label: 'Faceted industrial',
  kinds: {
    capital: beacon,
    connector: hexNode,
    freight_dock: dock,
    reactor: powerStation,
    cargo_bay: cargoHold,
    refinery,
  },
};
