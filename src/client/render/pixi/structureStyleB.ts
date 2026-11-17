/**
 * Structure style B, "clustered modules" (docs/plans/structure-restyle.md §4,
 * slice 1e): every building is an irregular cluster of round and hex pods
 * joined by short trusses and spines over a dark gantry deck on the kind's
 * outline (`structureOutline`). Domed pods, lit rim arcs and work-glow ports
 * (no sky-facing windows), owner livery bands and sigil slots. Same draw
 * plan and forge bake as style A (`structureStyleKit.ts`); only the drawers
 * differ.
 */
import {
  chevron, clipY, mixColor, ngon, outlinePx, polyBounds, polyEdgeDist, reach, scalePts, strip,
  type PolyOp, type Pt, type Pts, type StructureStyleDef, type StyleCtx,
} from './structureStyleKit.js';

const HULL = 0xb9b4a8;
const HULL_DARK = 0x7d8088;
const DECK = 0x14181f;
const TRUSS = 0x4a5260;
const WARM = 0xffc46a;
const RED = 0xff4d5e;
const GREEN = 0x7fe0a4;
const CYAN = 0x7cf7ff;
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

/** A stadium (rounded capsule) from x0 to x1 at y, `r` half-height. */
function capsule(x0: number, x1: number, y: number, r: number, seg = 6): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / seg;
    out.push([x1 + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / seg;
    out.push([x0 + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return out;
}

/** A ring segment (lit rim arc) around (cx, cy) between radii r0..r1. */
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, seg = 6): Pt[] {
  const outer: Pt[] = [], inner: Pt[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    outer.push([cx + r1 * Math.cos(a), cy + r1 * Math.sin(a)]);
    inner.push([cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)]);
  }
  return [...outer, ...inner.reverse()];
}

/** The footprint: only a faint gantry-net floor on the outline, so the
 *  modules and trusses, not a slab, carry the silhouette. */
function deck(c: StyleCtx): Pts {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, scalePts(out, 0.96), DECK, 'mark', 0.5, 1, { seams: 22, seamAngle: Math.PI / 4 });
  return out;
}

/** A module pod: collar, domed shell (round `sides` >= 10, else hex-ish),
 *  shrunk so it stays inside the outline. Returns the radius drawn. */
function pod(c: StyleCtx, out: Pts, cx: number, cy: number, r: number, sides: number, color: number, lift: number, rot = 0): number {
  const rr = Math.max(3, Math.min(r, polyEdgeDist(out, cx, cy) - 4));
  poly(c, ngon(cx, cy, rr, sides, rot), mixColor(color, 0x000000, 0.45), 'metal', lift * 0.4, 2);
  poly(c, ngon(cx, cy, rr * 0.86, sides, rot), color, 'metal', lift * 0.6, Math.max(1, rr * 0.08), { roof: [lift * 0.5, rr * 0.55] });
  return rr;
}

/** A short truss from a to b: a dark beam with cross-brace marks. */
function truss(c: StyleCtx, a: Pt, b: Pt, t: number, lift = 6): void {
  poly(c, strip(a, b, t), TRUSS, 'metal', lift, 1);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.floor(L / (t * 1.4)));
  for (let i = 1; i < n; i++) {
    const f = i / n, g = (i + 0.5) / n;
    const p: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const q: Pt = [a[0] + (b[0] - a[0]) * Math.min(1, g), a[1] + (b[1] - a[1]) * Math.min(1, g)];
    poly(c, strip(p, q, t * 0.28), mixColor(TRUSS, 0x000000, 0.5), 'mark', 0, 0.5);
  }
}

/** Lit rim arcs on a pod (in place of windows): two arcs on opposite sides. */
function rims(c: StyleCtx, cx: number, cy: number, r: number, a: number, color = WARM): void {
  glow(c, arc(cx, cy, r * 0.62, r * 0.7, a - 0.5, a + 0.5), color, 0.75);
  glow(c, arc(cx, cy, r * 0.62, r * 0.7, a + Math.PI - 0.4, a + Math.PI + 0.4), color, 0.6);
}

/** Point at angle `a`, fraction `k` of the outline's reach. */
function at(out: Pts, a: number, k: number): Pt {
  const R = reach(out, a) * k;
  return [Math.cos(a) * R, Math.sin(a) * R];
}

/** The beacon (capital): a big round core pod carrying the owner's sigil
 *  screen, ringed by an irregular cluster of hex and round satellite pods on
 *  trusses, beacon lamps on alternate satellites. */
function beacon(c: StyleCtx): void {
  const out = deck(c);
  const sats: Array<{ p: Pt; r: number; n: number }> = [];
  for (let k = 0; k < 7; k++) {
    const a = k * ((Math.PI * 2) / 7) + 0.3 + ((hash(c.seed, k) % 100) / 100 - 0.5) * 0.3;
    const big = k % 3 === 0;
    sats.push({ p: at(out, a, big ? 0.66 : 0.72), r: big ? 70 : 48, n: k % 2 === 0 ? 6 : 14 });
  }
  for (const s of sats) truss(c, [0, 0], s.p, 22, 8);
  for (let k = 0; k < sats.length; k++) if (k % 2 === 0) truss(c, sats[k]!.p, sats[(k + 1) % sats.length]!.p, 14, 7);
  sats.forEach((s, k) => {
    const r = pod(c, out, s.p[0], s.p[1], s.r, s.n, k % 3 === 0 ? HULL : HULL_DARK, 22, s.n === 6 ? Math.PI / 6 : 0);
    const a = Math.atan2(s.p[1], s.p[0]);
    if (k % 2 === 1) c.lit(s.p[0], s.p[1], 9, RED);
    else glow(c, ngon(s.p[0], s.p[1], r * 0.25, 6), CYAN, 0.7);
    rims(c, s.p[0], s.p[1], r, a + Math.PI / 2, CYAN);
    if (k % 3 === 0) band(c, strip([s.p[0] - r * 0.5, s.p[1] + r * 0.45], [s.p[0] + r * 0.5, s.p[1] + r * 0.45], 9));
  });
  // The core: collar, dome, accent ring, the sigil screen.
  poly(c, ngon(0, 0, 150, 16), mixColor(HULL, 0x000000, 0.45), 'metal', 10, 3);
  poly(c, ngon(0, 0, 138, 16), HULL, 'metal', 16, 6, { roof: [8, 30] });
  glow(c, arc(0, 0, 122, 130, -Math.PI * 0.9, -Math.PI * 0.1, 10), WARM, 0.7);
  poly(c, ngon(0, 0, 116, 16), mixColor(c.accent, HULL_DARK, 0.5), 'paint', 2, 2);
  glow(c, ngon(0, 0, 104, 16), mixColor(c.accent, 0x0a1420, 0.6), 0.8);
  if (c.livery) c.sigils.push({ x: 0, y: 0, r: 88, screen: true });
  else c.lit(0, 0, 26, c.accent);
}

/** Hex line node: a round hub pod with three hex knuckles on short struts. */
function hexNode(c: StyleCtx): void {
  const out = deck(c);
  for (let k = 0; k < 6; k += 2) {
    const a = k * (Math.PI / 3);
    const p: Pt = [Math.cos(a) * 19, Math.sin(a) * 19];
    truss(c, [0, 0], p, 6, 4);
    pod(c, out, p[0], p[1], 7, 6, HULL_DARK, 8, Math.PI / 6);
  }
  pod(c, out, 0, 0, 14, 12, HULL, 12);
  glow(c, ngon(0, 0, 6, 12), mixColor(c.accent, 0xffffff, 0.2), 1);
  band(c, strip([-7, 9], [7, 9], 3));
  c.lit(0, 0, 6, c.accent);
}

/** Medium dock (`freight_dock`): a hazard-striped lip with chevrons on the
 *  -y side; behind it a spine carrying a capsule sign module (big lit in
 *  arrow + cargo icon), a round hab pod with the emblem and a hex crane pod
 *  whose boom lies folded back along the spine. */
function dock(c: StyleCtx): void {
  const out = deck(c);
  const hh = c.H / 2;
  const lipY = -hh + c.H * 0.4;
  // Lip: hazard apron, bay floor, chevrons pointing in.
  poly(c, clipY(scalePts(out, 0.97), lipY - 6, false), 0xe8c547, 'hazard', 1, 1);
  poly(c, capsule(-190, 190, -hh + 18 + (c.H * 0.4 - 42) / 2, (c.H * 0.4 - 42) / 2), 0x23293a, 'mark', 0.5, 1);
  for (const lx of [-110, 110]) {
    for (let k = 0; k < 3; k++) glow(c, chevron(lx, -hh + 32 + k * 21, 70, 16, 6, 1), GREEN, 0.75);
  }
  // Spine along the house row.
  const sy = (lipY + hh) / 2 + 4;
  truss(c, [-236, sy], [236, sy], 26, 8);
  // Corner pods at the lip ends with the bay lamps.
  for (const sx of [-1, 1]) {
    truss(c, [sx * 222, sy], [sx * 222, -hh + 30], 12, 5);
    pod(c, out, sx * 222, -hh + 30, 20, 6, HULL_DARK, 12, Math.PI / 6);
    c.lit(sx * 222, -hh + 30, 7, GREEN);
  }
  // Sign module: a capsule pod, frame, glass, "in" arrow and ore icon.
  const sr = (hh - lipY) / 2 - 10;
  poly(c, capsule(-176, -64, sy, sr), mixColor(HULL, 0x000000, 0.45), 'metal', 10, 3);
  poly(c, capsule(-174, -66, sy, sr - 4), HULL, 'metal', 16, 4, { roof: [4, 10] });
  glow(c, capsule(-168, -72, sy, sr - 12), SIGN_GLASS, 1);
  glow(c, chevron(-160, sy, 40, 34, 11, 1), GREEN, 1.2);
  glow(c, ngon(-92, sy, 20, 6), WARM, 1.1);
  glow(c, ngon(-92, sy, 9, 6), SIGN_GLASS, 1);
  // Hab pod with the emblem.
  const hr = pod(c, out, 40, sy, sr + 4, 14, HULL_DARK, 20);
  rims(c, 40, sy, hr, 0);
  if (c.livery) c.sigils.push({ x: 40, y: sy, r: Math.min(32, hr * 0.5) });
  band(c, strip([-70, sy + sr - 2], [-170, sy + sr - 2], 8));
  // Crane pod and the boom folded back over the spine.
  const px = 196;
  pod(c, out, px, sy, 34, 6, HULL, 24, Math.PI / 6);
  poly(c, ngon(px, sy, 16, 6, Math.PI / 6), mixColor(HULL, 0x000000, 0.3), 'metal', 28, 2);
  poly(c, strip([px + 8, sy - 6], [-20, sy - sr * 0.6], 14), CRANE, 'paint', 30, 2);
  for (let t = 0.1; t < 0.95; t += 0.12) {
    const x = px + 8 + (-20 - px - 8) * t, y = sy - 6 + (-sr * 0.6 + 6) * t;
    poly(c, strip([x - 3, y], [x + 3, y], 10), mixColor(CRANE, 0x000000, 0.45), 'mark', 0, 0.5);
  }
  poly(c, ngon(-26, sy - sr * 0.6, 9, 6), HULL_DARK, 'metal', 4, 1);
  c.lit(px, sy, 6, WARM);
}

/** Power station (`reactor`): a big domed containment pod with a glowing
 *  port, an irregular ring of hex coolant pods and round tanks on spines. */
function powerStation(c: StyleCtx): void {
  const out = deck(c);
  const mods: Array<{ a: number; k: number; r: number; n: number }> = [
    { a: -2.4, k: 0.68, r: 52, n: 6 },
    { a: -1.2, k: 0.7, r: 40, n: 14 },
    { a: -0.2, k: 0.66, r: 56, n: 6 },
    { a: 1.0, k: 0.7, r: 38, n: 14 },
    { a: 1.9, k: 0.66, r: 50, n: 6 },
    { a: 2.9, k: 0.72, r: 34, n: 14 },
  ];
  const pts = mods.map((m) => at(out, m.a, m.k));
  pts.forEach((p, i) => truss(c, [0, 0], p, mods[i]!.n === 6 ? 24 : 14, 8));
  truss(c, pts[0]!, pts[1]!, 12, 6);
  truss(c, pts[3]!, pts[4]!, 12, 6);
  mods.forEach((m, i) => {
    const p = pts[i]!;
    const r = pod(c, out, p[0], p[1], m.r, m.n, m.n === 6 ? HULL : HULL_DARK, m.n === 6 ? 30 : 18, Math.PI / 6);
    if (m.n === 6) poly(c, ngon(p[0], p[1], r * 0.4, 6, Math.PI / 6), VENT, 'metal', -2, 2);
    else rims(c, p[0], p[1], r, m.a);
  });
  poly(c, ngon(0, 0, 96, 16), mixColor(HULL, 0x000000, 0.45), 'metal', 12, 3);
  poly(c, ngon(0, 0, 86, 16), HULL, 'metal', 20, 6, { roof: [10, 34] });
  glow(c, arc(0, 0, 70, 78, 0.3, 2.6, 8), WARM, 0.7);
  glow(c, ngon(0, 0, 42, 12), c.live ? mixColor(c.accent, 0xffffff, 0.15) : 0x553322, 1);
  c.lit(0, 0, 28, c.live ? c.accent : 0x553322);
  band(c, strip([-60, -62], [60, -62], 10));
  const sp = pts[1]!;
  if (c.livery) c.sigils.push({ x: sp[0], y: sp[1], r: 18 });
}

/** Cargo hold (`cargo_bay`): a central spine with rounded container pods of
 *  uneven length hung off both sides and a round hub at each end. */
function cargoHold(c: StyleCtx): void {
  const out = deck(c);
  truss(c, [-128, 0], [128, 0], 22, 8);
  const tints = [0x3f8f92, 0xb9772f, 0x5a6e9a, 0x8a6f9e];
  const rows: Array<[y: number, spans: Array<[number, number]>]> = [
    [-46, [[-96, -40], [-14, 38], [62, 96]]],
    [46, [[-92, -6], [24, 92]]],
  ];
  let k = 0;
  for (const [y, spans] of rows) {
    for (const [x0, x1] of spans) {
      truss(c, [(x0 + x1) / 2, 0], [(x0 + x1) / 2, y], 10, 6);
      const col = tints[hash(c.seed, k++) % tints.length]!;
      poly(c, capsule(x0, x1, y, 30), mixColor(col, 0x000000, 0.45), 'metal', 8, 2);
      poly(c, capsule(x0, x1, y, 26), col, 'paint', 14, 3, { roof: [5, 12], seams: 12, seamAngle: Math.PI / 2 });
    }
  }
  for (const sx of [-1, 1]) {
    const r = pod(c, out, sx * 128, 0, 30, 14, HULL, 18);
    rims(c, sx * 128, 0, r, Math.PI / 2);
    c.lit(sx * 128, 0, 6, WARM);
  }
  band(c, strip([-120, 8], [120, 8], 6));
  if (c.livery) c.sigils.push({ x: -53, y: 46, r: 20 });
}

/** Refinery: a clutch of spherical tanks of mixed sizes (work-glow ports)
 *  piped into a hex cracking-column pod that carries the emblem. */
function refinery(c: StyleCtx): void {
  const out = deck(c);
  const col: Pt = [70, -8];
  const tanks: Array<[number, number, number]> = [[-96, -50, 46], [-110, 46, 36], [-24, 4, 40], [-8, -84, 30], [6, 84, 34], [128, 60, 26]];
  for (const [tx, ty] of tanks) truss(c, [tx, ty], col, 10, 6);
  truss(c, [-96, -50], [-24, 4], 10, 6);
  for (const [tx, ty, tr] of tanks) {
    const r = pod(c, out, tx, ty, tr, 14, mixColor(c.accent, HULL, 0.55), 20);
    glow(c, ngon(tx, ty, Math.max(3, r * 0.22), 8), 0xff9a3a, 1);
  }
  pod(c, out, col[0], col[1], 50, 6, HULL, 34, Math.PI / 6);
  glow(c, arc(col[0], col[1], 30, 36, 0.4, 2.2, 6), 0xff9a3a, 0.7);
  band(c, strip([col[0] - 30, col[1] + 26], [col[0] + 30, col[1] + 26], 8));
  if (c.livery) c.sigils.push({ x: col[0], y: col[1] - 4, r: 20 });
  else glow(c, ngon(col[0], col[1], 14, 6), 0xff9a3a, 0.9);
  c.lit(col[0], col[1] - 30, 7, RED);
}

/** Style B's drawer table: one entry per restyled kind. */
export const STYLE_B: StructureStyleDef = {
  label: 'Clustered modules',
  kinds: {
    capital: beacon,
    connector: hexNode,
    freight_dock: dock,
    reactor: powerStation,
    cargo_bay: cargoHold,
    refinery,
  },
};
