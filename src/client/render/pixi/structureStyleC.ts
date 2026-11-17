/**
 * Structure style C, "shipyard brutalist" (docs/plans/structure-restyle.md §4,
 * slices 1f, 1i). Built in space, not on a rock: each building is a solid
 * gunmetal core slab inside an exposed X-braced truss frame, with strut
 * connectors where modules join, gantry walkways and a maintenance scaffold
 * partly wrapping it. Ordered: the outline is the clean symmetric chamfer
 * (`structureOutline(kind, 'c')`), modules are aligned and mirrored about the
 * vertical axis. Gritty: soot / gunmetal / oxidised steel, grime streaks, rivet
 * rows, weld seams, stained patch panels, chipped stencils and livery stripes,
 * few small hard amber / white work lamps. Drawn into the ordinary structure
 * draw plan with the shared kit; the forge bakes it, exactly like style A.
 */
import {
  chamferBox, chevron, mixColor, ngon, outlinePx, polyBounds, polyEdgeDist, rivetPolys, scalePts, strip, trussPolys,
  type PolyOp, type Pt, type Pts, type StructureStyleDef, type StyleCtx,
} from './structureStyleKit.js';
import { DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y } from '../../../core/articulation/rigCatalogue.js';

// Palette: soot, gunmetal, oxidised steel. Nothing pastel.
const DECK = 0x0d0e0f;
const SLAB = 0x2b2e31;
const SLAB_DARK = 0x1a1c1e;
const SLAB_LIGHT = 0x3a3d40;
const STEEL = 0x3b352e; // oxidised girder steel
const RUST = 0x4a3324;
const SOOT = 0x121110;
const RIVET = 0x55565a;
const WELD = 0x4c4f53;
const STENCIL = 0x8f8a7a; // worn off-white paint
const HAZARD = 0x9c7c2c; // dull, dirty hazard yellow
const CRANE = 0x7a6026; // weathered crane yellow
const LAMP_AMBER = 0xffa030;
const LAMP_WHITE = 0xfff1d6;
const SIGN_GLASS = 0x101418;
/** Muted shipping-container colours (rust, olive drab, navy grey, ochre). */
const CONTAINERS = [0x4a3022, 0x343c2c, 0x2a323b, 0x56472a] as const;

// ── Local shape helpers ────────────────────────────────────────────────────

/** Keep the part of `pts` with nx*x + ny*y <= d. */
function clipHalf(pts: Pts, nx: number, ny: number, d: number): Pt[] {
  const side = (p: Pt): number => nx * p[0] + ny * p[1] - d;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
/** The band of `pts` between two parallel lines across direction `ang`. */
function stripe(pts: Pts, ang: number, off: number, w: number): Pt[] {
  const nx = Math.cos(ang), ny = Math.sin(ang);
  return clipHalf(clipHalf(pts, nx, ny, off + w / 2), -nx, -ny, -(off - w / 2));
}
function fits(out: Pts, pts: Pts, m = 1): boolean {
  return pts.length >= 3 && pts.every(([x, y]) => polyEdgeDist(out, x, y) >= m);
}
/** mulberry32: a tiny seeded stream for the wear (grime, chips). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poly(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], lift: number, bevel: number, extra?: Partial<PolyOp>): void {
  if (pts.length >= 3 && fits(outlinePx(c.kindId, c.styleId), pts, 0)) c.polys.push({ pts, color, mat, lift, bevel, ...extra });
}
function glow(c: StyleCtx, pts: Pts, color: number, alpha = 1): void {
  poly(c, pts, color, 'glow', -0.8, 1, { alpha });
}
/** A small hard work lamp, only where it lands on the structure. */
function lamp(c: StyleCtx, x: number, y: number, r: number, color = LAMP_AMBER): void {
  if (polyEdgeDist(outlinePx(c.kindId, c.styleId), x, y) > r * 0.5) c.lit(x, y, r, color);
}

// ── Engineered parts ───────────────────────────────────────────────────────

/** The soot deck plate on the whole (symmetric chamfer) outline. */
function deck(c: StyleCtx): Pts {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 4, 3, { seams: 32, seamAngle: Math.PI / 2 });
  return out;
}

/** A solid core slab: a chamfered box, thick bevel, faceted roof, seams. */
function core(c: StyleCtx, pts: Pts, color = SLAB, lift = 20, seamAngle = 0): Pts {
  const b = polyBounds(pts);
  const run = Math.min(b.w, b.h) * 0.1;
  poly(c, pts, color, 'metal', lift, Math.max(3, run * 0.5), { roof: [3, run], seams: Math.max(16, Math.min(b.w, b.h) * 0.2), seamAngle });
  return pts;
}

/** An exposed lattice girder from `a` to `b`, `w` deep (`trussPolys`). */
function truss(c: StyleCtx, a: Pt, b: Pt, w: number, color = STEEL, lift = 8): void {
  trussPolys((pts, col, mat, l, bv) => poly(c, pts, col, mat, l, bv), a, b, w, color, lift);
}

/** A strut connector where two modules join: a bar with clamp collars. */
function strut(c: StyleCtx, a: Pt, b: Pt, w: number, lift = 10): void {
  poly(c, strip(a, b, w), STEEL, 'metal', lift, 1.2);
  for (const [x, y] of [a, b]) poly(c, chamferBox(x - w * 0.8, y - w * 0.8, w * 1.6, w * 1.6, w * 0.4), SLAB_LIGHT, 'metal', lift + 2, 1);
}

/** A gantry walkway from `a` to `b`: grating deck, cross rungs, hand rails. */
function walkway(c: StyleCtx, a: Pt, b: Pt, w: number, lift = 6): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, nx = -uy * (w / 2), ny = ux * (w / 2);
  poly(c, strip(a, b, w), SLAB_DARK, 'metal', lift, 0.8);
  for (let s = 3; s < L - 2; s += 5) {
    const p: Pt = [a[0] + ux * s, a[1] + uy * s];
    poly(c, strip([p[0] + nx * 0.8, p[1] + ny * 0.8], [p[0] - nx * 0.8, p[1] - ny * 0.8], 1.4), STEEL, 'metal', 0.6, 0.4);
  }
  for (const s of [1, -1]) poly(c, strip([a[0] + nx * s, a[1] + ny * s], [b[0] + nx * s, b[1] + ny * s], 1.6), RIVET, 'metal', 3, 0.5);
}

/** A maintenance scaffold over the box (x, y, w, h): a pole grid, one
 *  diagonal brace per row, plank decks on alternate rows. */
function scaffold(c: StyleCtx, x: number, y: number, w: number, h: number, step: number, lift = 8): void {
  const nx = Math.max(1, Math.round(w / step)), ny = Math.max(1, Math.round(h / step));
  const sx = w / nx, sy = h / ny;
  for (let j = 0; j < ny; j += 2) poly(c, chamferBox(x + 1, y + j * sy + 2, w - 2, sy - 4, 1.5), 0x3b3328, 'metal', lift - 2, 0.6, { seams: 4, seamAngle: 0 });
  for (let j = 0; j < ny; j++) {
    const i = j % nx;
    poly(c, strip([x + i * sx, y + j * sy], [x + (i + 1) * sx, y + (j + 1) * sy], 1.4), STEEL, 'metal', lift * 0.5, 0.7);
  }
  for (let i = 0; i <= nx; i++) poly(c, strip([x + i * sx, y], [x + i * sx, y + h], 1.8), STEEL, 'metal', lift * 0.6, 0.9);
  for (let j = 0; j <= ny; j++) poly(c, strip([x, y + j * sy], [x + w, y + j * sy], 1.8), STEEL, 'metal', lift * 0.6, 0.9);
}

/** A row of rivet heads from `a` to `b` (`rivetPolys`). */
function rivets(c: StyleCtx, a: Pt, b: Pt, step = 12, r = 2.2): void {
  rivetPolys((pts, col, mat, l, bv) => poly(c, pts, col, mat, l, bv), a, b, step, r, RIVET);
}

/** A weld seam (a raised bead) from `a` to `b`. */
function weld(c: StyleCtx, a: Pt, b: Pt): void {
  poly(c, strip(a, b, 1.6), WELD, 'metal', 0.7, 0.5);
}

/** Wear over the box (x, y, w, h): soot and rust streaks running +y from
 *  seeded points, and a couple of stained patch panels. */
function grime(c: StyleCtx, x: number, y: number, w: number, h: number, n: number, salt: number): void {
  const r = rng(c.seed * 7919 + salt);
  for (let k = 0; k < 2; k++) {
    const pw = w * (0.18 + 0.12 * r()), ph = h * (0.18 + 0.12 * r());
    poly(c, chamferBox(x + r() * (w - pw), y + r() * (h - ph), pw, ph, Math.min(pw, ph) * 0.15), mixColor(SLAB, RUST, 0.3), 'metal', 0.5, 0.6);
  }
  for (let k = 0; k < n; k++) {
    const sx = x + r() * w, sy = y + r() * h * 0.6, len = h * (0.2 + 0.35 * r()), sw = 6 + r() * 10;
    const col = r() < 0.35 ? RUST : SOOT;
    poly(c, [[sx - sw / 2, sy], [sx + sw / 2, sy], [sx + sw * 0.15, sy + len], [sx - sw * 0.15, sy + len]], col, 'mark', 0.2, 0.5);
  }
}

/** A painted stripe that has worn through in places: the band of `pts`
 *  across direction `ang` at `off`, `w` wide, broken into seeded segments
 *  along its length (the gaps show bare steel). The owner's band follows
 *  the same segments when livery is on. */
function wornStripe(c: StyleCtx, pts: Pts, ang: number, off: number, w: number, salt: number): void {
  const band = stripe(pts, ang, off, w);
  if (band.length < 3) return;
  const tx = -Math.sin(ang), ty = Math.cos(ang);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of band) { const s = x * tx + y * ty; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const r = rng(c.seed * 104729 + salt);
  const out = outlinePx(c.kindId, c.styleId);
  let s = lo;
  while (s < hi - 2) {
    const len = Math.min(hi - s, 10 + r() * 26);
    const seg = clipHalf(clipHalf(band, tx, ty, s + len), -tx, -ty, -s);
    if (seg.length >= 3) {
      poly(c, seg, mixColor(c.accent, SLAB_DARK, 0.7), 'paint', 0.8, 0.8);
      if (c.livery && fits(out, seg, 0)) c.bands.push({ ...polyBounds(seg), pts: seg });
    }
    s += len + 3 + r() * 7;
  }
}

/** Seven-segment stencil segments per digit (a b c d e f g). */
const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
/** A stencilled hull number, top-left at (x, y), digits `h` tall, in worn
 *  paint (one seeded segment per digit is chipped short). */
function stencil(c: StyleCtx, text: string, x: number, y: number, h: number): void {
  const w = h * 0.56, t = h * 0.16, g = t * 0.45, hm = h / 2;
  const r = rng(c.seed * 31 + text.charCodeAt(0));
  const bar = (bx: number, by: number, bw: number, bh: number): Pt[] => chamferBox(bx, by, bw, bh, t * 0.35);
  for (let i = 0; i < text.length; i++) {
    const ox = x + i * (w + h * 0.22);
    const segs: Record<string, Pt[]> = {
      a: bar(ox + t + g, y, w - 2 * t - 2 * g, t),
      b: bar(ox + w - t, y + t / 2 + g, t, hm - t / 2 - 2 * g),
      c: bar(ox + w - t, y + hm + g, t, hm - t / 2 - 2 * g),
      d: bar(ox + t + g, y + h - t, w - 2 * t - 2 * g, t),
      e: bar(ox, y + hm + g, t, hm - t / 2 - 2 * g),
      f: bar(ox, y + t / 2 + g, t, hm - t / 2 - 2 * g),
      g: bar(ox + t + g, y + hm - t / 2, w - 2 * t - 2 * g, t),
    };
    const segList = SEG[text[i]!] ?? '';
    const chipped = segList[Math.floor(r() * segList.length)];
    for (const s of segList) {
      const p = segs[s]!;
      poly(c, s === chipped ? scalePts(p, 0.7, 0.7, p[0]![0], p[0]![1]) : p, STENCIL, 'mark', 0.5, 0.5);
    }
  }
}

/** Four trusses framing the box (x, y, w, h) on its outside, `d` deep. */
function frame(c: StyleCtx, x: number, y: number, w: number, h: number, d: number, lift = 9): void {
  truss(c, [x + d, y - d / 2], [x + w - d, y - d / 2], d, STEEL, lift);
  truss(c, [x + d, y + h + d / 2], [x + w - d, y + h + d / 2], d, STEEL, lift);
  truss(c, [x - d / 2, y + d], [x - d / 2, y + h - d], d, STEEL, lift);
  truss(c, [x + w + d / 2, y + d], [x + w + d / 2, y + h - d], d, STEEL, lift);
}

// ── Per-kind drawers ───────────────────────────────────────────────────────

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

/** Hex node (connector): a hex core, six radial clamp struts, a dark socket
 *  with a small amber slit, a worn stripe across. */
function hexNode(c: StyleCtx): void {
  const out = deck(c);
  const hex = core(c, scalePts(out, 0.62), SLAB, 10, 0);
  wornStripe(c, hex, Math.PI / 2, 12, 5, 3);
  for (let k = 0; k < 6; k++) {
    const a = (k + 0.5) * (Math.PI / 3);
    poly(c, strip([Math.cos(a) * 17, Math.sin(a) * 17], [Math.cos(a) * 25, Math.sin(a) * 25], 5), STEEL, 'metal', 6, 1);
  }
  poly(c, ngon(0, 0, 9, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 1.5);
  glow(c, chamferBox(-5, -1.5, 10, 3, 1), LAMP_AMBER, 0.7);
  c.lit(0, 0, 3, LAMP_AMBER);
}

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

/** Refinery: a tall chamfered cracking column on the axis, two octagonal
 *  tank bunkers mirrored either side and strutted in, pipe-rack trusses
 *  above and below, a scaffold up the column, small hard work-glow slits. */
function refinery(c: StyleCtx): void {
  deck(c);
  grime(c, -170, -130, 340, 260, 12, 6);
  for (const s of [-1, 1]) truss(c, [-150, s * 104], [150, s * 104], 24, STEEL, 12);
  for (const s of [-1, 1]) {
    const tank = core(c, ngon(s * 112, 0, 56, 8, Math.PI / 8), 0x3a3631, 22, Math.PI / 2);
    poly(c, ngon(s * 112, 0, 26, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 2);
    rivets(c, [s * 112 - 40, -40], [s * 112 + 40, -40], 10);
    wornStripe(c, tank, Math.PI / 2, 30, 8, 50 + s);
    strut(c, [s * 58, 0], [s * 40, 0], 12, 16);
    for (const t of [-1, 1]) strut(c, [s * 112, t * 58], [s * 112, t * 92], 8, 14);
    glow(c, chamferBox(s * 112 - 12, -2, 24, 4, 1.5), LAMP_AMBER, 0.7);
  }
  const col = core(c, chamferBox(-40, -124, 80, 248, 20), SLAB_LIGHT, 40, 0);
  weld(c, [-30, -40], [30, -40]);
  weld(c, [-30, 40], [30, 40]);
  wornStripe(c, col, Math.PI / 2, 84, 12, 60);
  for (const y of [-12, 60]) glow(c, chamferBox(-20, y - 2, 40, 4, 1.5), LAMP_AMBER, 0.6);
  scaffold(c, -48, -124, 96, 64, 16, 12);
  stencil(c, '21', -15, 8, 24);
  if (c.livery) c.sigils.push({ x: 0, y: -26, r: 16 });
  lamp(c, 0, -112, 4, LAMP_WHITE);
  for (const s of [-1, 1]) lamp(c, s * 150, -104, 3.5, LAMP_AMBER);
}

/** Style C's drawer table: one entry per restyled kind. */
export const STYLE_C: StructureStyleDef = {
  label: 'Shipyard brutalist',
  kinds: {
    capital: beacon,
    connector: hexNode,
    freight_dock: dock,
    reactor: powerStation,
    cargo_bay: cargoHold,
    refinery,
  },
};
