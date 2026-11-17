/**
 * Structure style C, "shipyard brutalist" (docs/plans/structure-restyle.md §4,
 * slice 1f): heavy slabs cut from the kind's outline (`structureOutline`) by
 * angled planes, thick chamfered bevels, exposed girder frames and gantry
 * ribs, big stencilled hull numbers, a dark heavy palette with the owner
 * livery as bold stripes. Lit slits, signs and work-glow ports only (no
 * sky-facing windows). Drawn into the ordinary structure draw plan with the
 * shared kit; the forge bakes it, exactly like style A.
 */
import {
  chamferBox, chevron, mixColor, ngon, outlinePx, polyBounds, polyEdgeDist, reach, scalePts, strip,
  type PolyOp, type Pt, type Pts, type StructureStyleDef, type StyleCtx,
} from './structureStyleKit.js';

const DECK = 0x111317;
const SLAB = 0x353a42;
const SLAB_DARK = 0x23272e;
const SLAB_LIGHT = 0x4c525b;
const GIRDER = 0x6a6156;
const STENCIL = 0xd6cdb0;
const HAZARD = 0xe0b030;
const AMBER = 0xffb347;
const RED = 0xff4d5e;
const SIGN_GLASS = 0x182430;
const CRANE = 0xc9952c;
const VENT = 0x15181d;

// ── Local shape helpers ────────────────────────────────────────────────────

/** Keep the part of `pts` with nx*x + ny*y <= d (one angled cut). */
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
/** Angled cut: drop the part of `pts` beyond `d` along direction `ang`. */
function cut(pts: Pts, ang: number, d: number): Pt[] {
  return clipHalf(pts, Math.cos(ang), Math.sin(ang), d);
}
/** The band of `pts` between two parallel lines across direction `ang`. */
function stripe(pts: Pts, ang: number, off: number, w: number): Pt[] {
  const nx = Math.cos(ang), ny = Math.sin(ang);
  return clipHalf(clipHalf(pts, nx, ny, off + w / 2), -nx, -ny, -(off - w / 2));
}
function fits(out: Pts, pts: Pts, m = 1): boolean {
  return pts.length >= 3 && pts.every(([x, y]) => polyEdgeDist(out, x, y) >= m);
}

function poly(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], lift: number, bevel: number, extra?: Partial<PolyOp>): void {
  if (pts.length >= 3 && fits(outlinePx(c.kindId, c.styleId), pts, 0)) c.polys.push({ pts, color, mat, lift, bevel, ...extra });
}
function glow(c: StyleCtx, pts: Pts, color: number, alpha = 1): void {
  poly(c, pts, color, 'glow', -0.8, 1, { alpha });
}

/** The heavy slab: plinth on the outline, then the outline shrunk and cut by
 *  angled planes (asymmetric, never square), thick bevel, faceted roof. */
function slab(c: StyleCtx, k: number, cuts: ReadonlyArray<readonly [ang: number, frac: number]>, seamAngle = 0): Pts {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 4, 3);
  let s: Pts = scalePts(out, k);
  for (const [a, f] of cuts) s = cut(s, a, f * reach(out, a));
  const run = Math.min(c.W, c.H) * 0.08;
  poly(c, s, SLAB, 'metal', 18, Math.max(3, run * 0.6), { roof: [3, run], seams: Math.max(18, Math.min(c.W, c.H) * 0.22), seamAngle });
  return s;
}

/** Gantry ribs: heavy bars across `pts` along direction `ang`. */
function ribs(c: StyleCtx, pts: Pts, ang: number, from: number, to: number, step: number, w: number, color = SLAB_LIGHT): void {
  for (let o = from; o <= to + 1e-6; o += step) poly(c, stripe(pts, ang, o, w), color, 'metal', 5, 2);
}

/** An exposed girder frame from `a` to `b`: two rails and zig-zag lacing. */
function girder(c: StyleCtx, a: Pt, b: Pt, w: number, color = GIRDER, lift = 8): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2);
  const at = (t: number, s: number): Pt => [a[0] + dx * t + nx * s, a[1] + dy * t + ny * s];
  const rail = Math.max(2, w * 0.18);
  const n = Math.max(2, Math.round(L / w));
  for (let i = 0; i < n; i++) {
    const s = i % 2 === 0 ? 1 : -1;
    poly(c, strip(at(i / n, s * 0.8), at((i + 1) / n, -s * 0.8), rail * 0.7), mixColor(color, 0x000000, 0.3), 'metal', lift - 2, 1);
  }
  poly(c, strip(at(0, 1), at(1, 1), rail), color, 'metal', lift, 1);
  poly(c, strip(at(0, -1), at(1, -1), rail), color, 'metal', lift, 1);
}

/** The livery stripe: a painted plate always (accent, darkened), and the
 *  owner's band over it when livery is on. */
function liveryStripe(c: StyleCtx, pts: Pts): void {
  if (pts.length < 3) return;
  poly(c, pts, mixColor(c.accent, SLAB_DARK, 0.45), 'paint', 1, 1.5);
  if (c.livery && fits(outlinePx(c.kindId, c.styleId), pts, 0)) c.bands.push({ ...polyBounds(pts), pts });
}

/** Seven-segment stencil segments per digit (a b c d e f g). */
const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
/** A big stencilled hull number, top-left at (x, y), digits `h` tall. Each
 *  segment is a separate chamfered bar (the stencil bridges show as gaps). */
function stencil(c: StyleCtx, text: string, x: number, y: number, h: number, color = STENCIL): void {
  const w = h * 0.56, t = h * 0.16, g = t * 0.45, hm = h / 2;
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
    for (const s of SEG[text[i]!] ?? '') poly(c, segs[s]!, color, 'mark', 0.5, 0.5);
  }
}

/** A lamp, only where it lands on the structure. */
function lamp(c: StyleCtx, x: number, y: number, r: number, color: number): void {
  if (polyEdgeDist(outlinePx(c.kindId, c.styleId), x, y) > r * 0.5) c.lit(x, y, r, color);
}

// ── Per-kind drawers ───────────────────────────────────────────────────────

/** The beacon (capital): a cut slab under gantry ribs, a massive chamfered
 *  keep in the middle holding the owner's big sigil screen, girder frames
 *  on two flanks, a bold diagonal livery stripe, hull number 01. */
function beacon(c: StyleCtx): void {
  const s = slab(c, 0.92, [[-Math.PI / 4, 0.78], [(3 * Math.PI) / 4, 0.82]], Math.PI / 2);
  ribs(c, s, 0, -210, 210, 52, 14);
  liveryStripe(c, stripe(s, Math.PI / 4, 168, 56));
  liveryStripe(c, stripe(s, Math.PI / 4, 214, 16));
  const out = outlinePx(c.kindId, c.styleId);
  for (const a of [Math.PI, -Math.PI / 2]) {
    const R = 0.8 * reach(out, a), ux = Math.cos(a), uy = Math.sin(a);
    const m = (R + 150) / 2;
    girder(c, [ux * m - uy * 90, uy * m + ux * 90], [ux * m + uy * 90, uy * m - ux * 90], 34);
  }
  // The keep: a heavy octagonal block, a dark bezel, the lit screen.
  poly(c, chamferBox(-150, -150, 300, 300, 62), SLAB_LIGHT, 'metal', 30, 12, { roof: [5, 22], seams: 60, seamAngle: 0 });
  poly(c, chamferBox(-122, -122, 244, 244, 48), SLAB_DARK, 'metal', 2, 3);
  glow(c, chamferBox(-110, -110, 220, 220, 42), mixColor(c.accent, 0x0a1420, 0.6), 0.85);
  if (c.livery) c.sigils.push({ x: 0, y: 0, r: 92, screen: true });
  else c.lit(0, 0, 28, c.accent);
  // Red work lamps on the keep's cut corners.
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) lamp(c, sx * 118, sy * 118, 8, RED);
  stencil(c, '01', 40, 166, 54);
}

/** Hex node (connector): a cut hex slab, three heavy clamp blocks, a dark
 *  socket with a lit slit, a livery stripe across. */
function hexNode(c: StyleCtx): void {
  const s = slab(c, 0.86, [[Math.PI / 3, 0.62]]);
  liveryStripe(c, stripe(s, Math.PI / 2, 15, 7));
  for (let k = 1; k < 6; k += 2) {
    const a = k * (Math.PI / 3);
    poly(c, strip([Math.cos(a) * 12, Math.sin(a) * 12], [Math.cos(a) * 23, Math.sin(a) * 23], 11), SLAB_LIGHT, 'metal', 6, 2);
  }
  poly(c, ngon(0, 0, 12, 8, Math.PI / 8), SLAB_DARK, 'metal', 4, 2);
  glow(c, chamferBox(-8, -2.5, 16, 5, 1.5), mixColor(c.accent, 0xffffff, 0.2), 1);
  c.lit(0, 0, 6, c.accent);
}

/** Medium dock (`freight_dock` evolved): a hazard-striped lip on the -y
 *  side with amber chevrons running in, the slab dock house under vertical
 *  gantry ribs, a big lit sign, and the crane folded as a girder boom. */
function dock(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  const hh = c.H / 2;
  const lipY = -hh + c.H * 0.4;
  poly(c, out, DECK, 'metal', 4, 3);
  // Lip: hazard apron, dark bay floor, chevrons pointing into the bay.
  poly(c, clipHalf(scalePts(out, 0.97), 0, 1, lipY - 4), HAZARD, 'hazard', 1.5, 1);
  poly(c, chamferBox(-196, -hh + 22, 392, c.H * 0.4 - 46, 14), 0x1b1e24, 'mark', 0.5, 1);
  for (const lx of [-120, 0, 120]) {
    for (let k = 0; k < 2; k++) poly(c, chevron(lx, -hh + 40 + k * 26, 64, 20, 9, 1), AMBER, 'paint', 1, 0.5);
  }
  // Dock house: the outline below the lip, one angled cut, ribs.
  let house: Pts = clipHalf(scalePts(out, 0.94), 0, -1, -(lipY + 4));
  house = cut(house, Math.PI / 4 - 0.15, 0.82 * reach(out, Math.PI / 4 - 0.15));
  poly(c, house, SLAB, 'metal', 20, 9, { roof: [3, 18], seams: 48, seamAngle: Math.PI / 2 });
  ribs(c, house, 0, 30, 230, 40, 10);
  liveryStripe(c, stripe(house, 0, -228, 30));
  glow(c, chamferBox(-180, lipY + 6, 360, 4, 1.5), AMBER, 0.6);
  // The big lit sign: heavy frame, glass, an "in" arrow, a crate icon.
  const sy = lipY + 22, sh = hh - lipY - 50;
  poly(c, chamferBox(-196, sy - 8, 214, sh + 16, 18), SLAB_LIGHT, 'metal', 6, 3);
  glow(c, chamferBox(-188, sy, 198, sh, 14), SIGN_GLASS, 1);
  glow(c, chevron(-140, sy + sh / 2, 56, 44, 14, -1), AMBER, 1.2);
  glow(c, chamferBox(-82, sy + sh / 2 - 22, 50, 44, 10), 0x7fe0a4, 1.1);
  glow(c, chamferBox(-70, sy + sh / 2 - 10, 26, 20, 4), SIGN_GLASS, 1);
  // Folded crane: a pivot block, a yellow girder boom laid along the roof.
  const py = lipY + 40;
  poly(c, chamferBox(178, py - 22, 50, 44, 12), SLAB_LIGHT, 'metal', 30, 5, { roof: [4, 10] });
  girder(c, [176, py], [36, lipY + 18], 22, CRANE, 32);
  poly(c, chamferBox(24, lipY + 8, 20, 20, 5), SLAB_LIGHT, 'metal', 4, 1);
  lamp(c, 203, py, 6, AMBER);
  stencil(c, '12', 70, hh - 60, 40);
  if (c.livery) c.sigils.push({ x: 150, y: hh - 40, r: 26 });
  lamp(c, -226, -hh + 22, 7, RED);
  lamp(c, 226, -hh + 22, 7, RED);
}

/** Power station (`reactor`): a cut slab, a thick-walled containment keep
 *  with a deep pit and glowing core, two ribbed cooling blocks tied in by
 *  girders, a corner livery stripe, hull number 07. */
function powerStation(c: StyleCtx): void {
  const s = slab(c, 0.92, [[-Math.PI / 4, 0.74], [Math.PI * 0.8, 0.86]], Math.PI / 2);
  liveryStripe(c, stripe(s, -Math.PI / 4, 196, 44));
  for (const sy of [-1, 1]) {
    girder(c, [-96, sy * 104], [-28, sy * 60], 26);
    const blk = chamferBox(-170, sy * 104 - 42, 84, 84, 18);
    poly(c, blk, SLAB_LIGHT, 'metal', 26, 8, { roof: [4, 12] });
    ribs(c, blk, 0, -158, -98, 15, 6, VENT);
  }
  poly(c, ngon(30, 0, 112, 8, Math.PI / 8), SLAB_LIGHT, 'metal', 30, 12, { roof: [4, 26], seams: 40, seamAngle: 0 });
  poly(c, ngon(30, 0, 70, 8, Math.PI / 8), VENT, 'metal', -6, 6);
  glow(c, ngon(30, 0, 40, 8, Math.PI / 8), c.live ? mixColor(c.accent, 0xffffff, 0.15) : 0x553322, 1);
  c.lit(30, 0, 30, c.live ? c.accent : 0x553322);
  for (const [sx, sy] of [[1, -1], [1, 1]] as const) lamp(c, 30 + sx * 96, sy * 40, 7, RED);
  stencil(c, '07', -40, 120, 50);
  if (c.livery) c.sigils.push({ x: 120, y: -120, r: 24 });
}

/** Cargo hold (`cargo_bay`): a slab under a girder gantry frame (two rails,
 *  a bridge) over four heavy, ribbed container blocks; hull number 33. */
function cargoHold(c: StyleCtx): void {
  const s = slab(c, 0.92, [[Math.PI * 0.85, 0.8]]);
  liveryStripe(c, stripe(s, 0, 120, 26));
  const tints = [0x5c3a2a, 0x3e4a36, 0x2f3d55, 0x6b5530];
  let k = 0;
  for (const cy of [-36, 36]) {
    for (const cx of [-48, 40]) {
      const box = chamferBox(cx - 42, cy - 28, 84, 56, 10);
      poly(c, box, tints[(c.seed + k++) % 4]!, 'paint', 16, 5, { roof: [3, 10] });
      ribs(c, box, 0, cx - 30, cx + 30, 15, 4, mixColor(SLAB_DARK, 0x000000, 0.2));
    }
  }
  girder(c, [-126, -72], [96, -72], 16, GIRDER, 30);
  girder(c, [-126, 72], [96, 72], 16, GIRDER, 30);
  poly(c, chamferBox(-6, -80, 24, 160, 6), mixColor(HAZARD, SLAB, 0.25), 'paint', 34, 3);
  for (const y of [-50, 0, 50]) glow(c, chamferBox(-1, y - 8, 14, 16, 3), AMBER, 0.9);
  stencil(c, '33', -136, -30, 44);
  if (c.livery) c.sigils.push({ x: 120, y: -50, r: 18 });
  lamp(c, 6, -80, 6, AMBER);
  lamp(c, 6, 80, 6, AMBER);
}

/** Refinery: a cut slab, two heavy octagonal tank bunkers piped by girders
 *  into a tall chamfered cracking block on the right, work-glow slits, a
 *  livery stripe on the block, hull number 21. */
function refinery(c: StyleCtx): void {
  const s = slab(c, 0.93, [[Math.PI * 1.2, 0.8], [Math.PI / 5, 0.85]], Math.PI / 2);
  const tower = chamferBox(48, -110, 104, 210, 30);
  for (const ty of [-62, 58]) {
    girder(c, [-50, ty], [52, ty * 0.6], 22);
    poly(c, ngon(-80, ty, 50, 8, Math.PI / 8), mixColor(c.accent, SLAB, 0.65), 'paint', 22, 8, { roof: [6, 16] });
    poly(c, ngon(-80, ty, 22, 8, Math.PI / 8), SLAB_DARK, 'metal', 3, 2);
    glow(c, chamferBox(-96, ty - 3, 32, 6, 2), 0xff9a3a, 1);
  }
  poly(c, tower, SLAB_LIGHT, 'metal', 40, 12, { roof: [6, 22], seams: 34, seamAngle: 0 });
  ribs(c, tower, Math.PI / 2, -86, 76, 34, 8, SLAB_DARK);
  liveryStripe(c, stripe(tower, 0, 128, 18));
  for (const y of [-70, 0, 70]) glow(c, chamferBox(62, y - 3, 40, 6, 2), 0xff9a3a, 0.9);
  if (c.livery) c.sigils.push({ x: 92, y: -34, r: 20 });
  lamp(c, 100, -96, 7, RED);
  stencil(c, '21', -146, -16, 34);
  void s;
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
