/**
 * Structure restyle kit (docs/plans/structure-restyle.md §4, slice 1d): the
 * shape vocabulary a structure STYLE draws with. A style draws faceted
 * POLYGONS (`PolyOp`) into the same draw plan the rect art uses
 * (`structureVisuals.ts`), and the forge bakes them (`fields.ts`
 * `forgeStructure`), so there is still one plan and one bake path.
 *
 * Pure and deterministic (no Pixi). Pixi space (y down), centred on the
 * structure, in catalogue footprint units.
 */
import { structureOutline, type StructureKindId } from '../../../shared-types/structureKinds.js';
import { PAD_SPECS, isPadChamberKind, padHalfExtent } from '../../../shared-types/teleport.js';
import { insidePoly } from '../art/raster.js';

export { insidePoly };

export type Pt = readonly [number, number];
export type Pts = ReadonlyArray<Pt>;

/** How the forge treats a polygon. `metal`: bevelled steel plate. `paint`:
 *  painted plate (accent / hazard yellow). `glow`: lit glass (emissive, inset;
 *  signs, trims, work-glow ports; never sky-facing windows). `mark`: flat
 *  floor paint. `hazard`: diagonal yellow/black stripes. */
export type PolyMat = 'metal' | 'paint' | 'glow' | 'mark' | 'hazard';

/** A faceted polygon in the draw plan (pixi space). */
export interface PolyOp {
  pts: Pts;
  color: number;
  mat: PolyMat;
  /** Height the plate stands above what is under it. */
  lift: number;
  /** Bevel width (world units): the edge ramps up over this distance. */
  bevel: number;
  /** Faceted roof: extra `rise` reached `run` units in from the edge. Its
   *  ridges run from each corner inward, so every face is a flat facet. */
  roof?: readonly [rise: number, run: number];
  /** Panel lines: parallel seams `seams` units apart at `seamAngle` rad. */
  seams?: number;
  seamAngle?: number;
  /** Glow strength (glow only); default 1. */
  alpha?: number;
}

/** Blend colour `c` toward `target` by `t` (0..1), per channel. */
export function mixColor(c: number, target: number, t: number): number {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
  const tr = (target >> 16) & 0xff, tg = (target >> 8) & 0xff, tb = target & 0xff;
  const rr = Math.round(r + (tr - r) * t), gg = Math.round(g + (tg - g) * t), bb = Math.round(b + (tb - b) * t);
  return (rr << 16) | (gg << 8) | bb;
}

/** The kind's outline (`structureOutline`, the shape seam) in pixi space. */
export function outlinePx(kindId: string, styleId: string): Pt[] {
  return structureOutline(kindId, styleId).map((p) => [p.x, -p.y] as const);
}

/** A teleporter chamber's art frame cut, as a fraction of its tower side. */
export const CHAMBER_FRAME_CUT = 0.3;

/** The polygon a kind's style art must fit in: its outline, except a
 *  teleporter CHAMBER (`isPadChamberKind`), whose walls and towers (the
 *  collider, `gateColliderBoxes`) fill the whole footprint square: there
 *  the frame is that square with the corner towers' outer corners cut. */
export function artFramePx(kindId: string, styleId: string): Pt[] {
  if (!isPadChamberKind(kindId)) return outlinePx(kindId, styleId);
  const h = padHalfExtent(kindId), k = PAD_SPECS[kindId].post * CHAMBER_FRAME_CUT;
  return chamferBox(-h - 1, -h - 1, 2 * h + 2, 2 * h + 2, k); // 1 unit over: art may run to the footprint edge
}

/** Scale points about (cx, cy). */
export function scalePts(pts: Pts, kx: number, ky = kx, cx = 0, cy = 0): Pt[] {
  return pts.map(([x, y]) => [cx + (x - cx) * kx, cy + (y - cy) * ky] as const);
}

/** A regular n-gon (flat-top hexagon at n = 6, rot = 0). */
export function ngon(cx: number, cy: number, r: number, n: number, rot = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI * 2) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** A box with all four corners cut by `c` (never a plain rectangle). */
export function chamferBox(x: number, y: number, w: number, h: number, c: number): Pt[] {
  const k = Math.min(c, w / 2, h / 2);
  return [[x + k, y], [x + w - k, y], [x + w, y + k], [x + w, y + h - k], [x + w - k, y + h], [x + k, y + h], [x, y + h - k], [x, y + k]];
}

/** A chevron centred on (cx, cy), `w` wide, `h` tall, pointing `dir`
 *  (-1 = up / -y, +1 = down / +y), arm thickness `t`. */
export function chevron(cx: number, cy: number, w: number, h: number, t: number, dir: 1 | -1): Pt[] {
  const tip = cy + (dir * h) / 2, back = cy - (dir * h) / 2;
  return [[cx - w / 2, back], [cx, tip - dir * (h - t)], [cx + w / 2, back], [cx + w / 2, back + dir * t], [cx, tip], [cx - w / 2, back + dir * t]];
}

/** A quad strip from `a` to `b`, `t` wide (a straight conduit or boom). */
export function strip(a: Pt, b: Pt, t: number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (t / 2), ny = (dx / L) * (t / 2);
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/** A lit trim along edge `i` of `pts` (from fraction t0 to t1 of the edge),
 *  set `inset` units in toward the centroid, `thick` deep. */
export function edgeTrim(pts: Pts, i: number, t0: number, t1: number, inset: number, thick: number): Pt[] {
  const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
  const [cx, cy] = centroid(pts);
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L, ny = dx / L;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
  const p = (t: number, d: number): Pt => [a[0] + dx * t + nx * d, a[1] + dy * t + ny * d];
  return [p(t0, inset), p(t1, inset), p(t1, inset + thick), p(t0, inset + thick)];
}

export function centroid(pts: Pts): Pt {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

/** Signed distance to the polygon's boundary (positive inside). */
export function polyEdgeDist(pts: Pts, x: number, y: number): number {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j]!, [bx, by] = pts[i]!;
    const ex = bx - ax, ey = by - ay;
    const L2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2));
    d = Math.min(d, Math.hypot(x - (ax + ex * t), y - (ay + ey * t)));
  }
  return insidePoly(pts, x, y) ? d : -d;
}

/** Axis-aligned bounds of a polygon. */
export function polyBounds(pts: Pts): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Distance from the origin to the polygon's boundary along angle `a` (the
 *  outline is star-shaped about the origin, so the first hit is the edge). */
export function reach(pts: Pts, a: number): number {
  const dx = Math.cos(a), dy = Math.sin(a);
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j]!, [bx, by] = pts[i]!;
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** Clip a polygon to the half-plane y <= `yc` (or y >= `yc` with `keepGreater`). */
export function clipY(pts: Pts, yc: number, keepGreater: boolean): Pt[] {
  const inside = (p: Pt): boolean => (keepGreater ? p[1] >= yc : p[1] <= yc);
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (yc - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, yc]);
    }
  }
  return out;
}

/** Livery and sigil ops a style emits (the 1c shapes; a band may be a polygon). */
export interface StyleSigilSlot { x: number; y: number; r: number; screen?: boolean }
export interface StyleBand { x: number; y: number; w: number; h: number; pts?: Pts }

/** What a style's per-kind drawer gets: the footprint, the kind's accent and
 *  seed, and the plan's op lists to push into. */
export interface StyleCtx {
  kindId: string;
  styleId: string;
  W: number;
  H: number;
  accent: number;
  seed: number;
  live: boolean;
  /** Owner livery on (the default; `?structLivery=0` = off): push sigil slots and bands. */
  livery: boolean;
  polys: PolyOp[];
  sigils: StyleSigilSlot[];
  bands: StyleBand[];
  /** Add a lamp (skipped when unpowered). */
  lit(x: number, y: number, r: number, color: number): void;
  /** Lit deck spike: a road's local arm mask, baked into its art (absent = today's plan). */
  arms?: number;
  /** Art frame override for `poly`'s fit check (absent = `artFramePx`); the
   *  road's lit bake sets the full deck hex, so its arms reach the seams. */
  frame?: Pts;
}

export type StyleDrawer = (c: StyleCtx) => void;

/** A structure style direction: a drawer per kind it restyles. Kinds without
 *  one keep today's art. */
export interface StructureStyleDef {
  /** Human name (art lab / Artifact captions). */
  label: string;
  kinds: Readonly<Partial<Record<string, StyleDrawer>>>;
  /** Per-kind drawing version, part of the stored bake key
   *  (`structureStyleVersion`); absent or empty adds nothing. */
  kindVersions?: Readonly<Partial<Record<string, string>>>;
}

/** One family's drawers in a style (style C: `structureStyleC.<family>.ts`). */
export type StyleDrawerTable = Readonly<Partial<Record<StructureKindId, StyleDrawer>>>;

// ── Shared engineered parts (style C trusses; reused by the rig parts) ─────

/** Where a part helper puts each polygon: a style pushes it into its plan
 *  (clipped to the outline), the rig parts paint it flat (`structureRigs`). */
export type PolySink = (pts: Pts, color: number, mat: PolyMat, lift: number, bevel: number) => void;

/** An exposed lattice girder from `a` to `b`, `w` deep: two chords, a post
 *  at every bay and X-bracing across each bay (laces first, then posts,
 *  then the chords on top). */
export function trussPolys(sink: PolySink, a: Pt, b: Pt, w: number, color: number, lift: number): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2);
  const at = (t: number, s: number): Pt => [a[0] + dx * t + nx * s, a[1] + dy * t + ny * s];
  const chord = Math.max(1.6, w * 0.14);
  const n = Math.max(1, Math.round(L / w));
  const lace = mixColor(color, 0x000000, 0.28);
  for (let i = 0; i < n; i++) {
    sink(strip(at(i / n, 0.85), at((i + 1) / n, -0.85), chord * 0.6), lace, 'metal', lift * 0.5, chord * 0.3);
    sink(strip(at(i / n, -0.85), at((i + 1) / n, 0.85), chord * 0.6), lace, 'metal', lift * 0.5, chord * 0.3);
  }
  for (let i = 0; i <= n; i++) sink(strip(at(i / n, 1), at(i / n, -1), chord * 0.8), color, 'metal', lift * 0.7, chord * 0.4);
  sink(strip(at(0, 1), at(1, 1), chord), color, 'metal', lift * 0.8, chord * 0.5);
  sink(strip(at(0, -1), at(1, -1), chord), color, 'metal', lift * 0.8, chord * 0.5);
}

/** A row of rivet heads from `a` to `b`. */
export function rivetPolys(sink: PolySink, a: Pt, b: Pt, step: number, r: number, color: number): void {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    sink(ngon(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, 6), color, 'metal', 1, 0.6);
  }
}

// ── Style C vocabulary (palette + parts), shared by its family files ───────
// (structureStyleC.<family>.ts; docs/plans/structure-restyle-stage4.md §4 0a)

// Palette: soot, gunmetal, oxidised steel. Nothing pastel.
export const DECK = 0x0d0e0f;
export const SLAB = 0x2b2e31;
export const SLAB_DARK = 0x1a1c1e;
export const SLAB_LIGHT = 0x3a3d40;
export const STEEL = 0x3b352e; // oxidised girder steel
export const RUST = 0x4a3324;
export const SOOT = 0x121110;
export const RIVET = 0x55565a;
export const WELD = 0x4c4f53;
export const STENCIL = 0x8f8a7a; // worn off-white paint
export const HAZARD = 0x9c7c2c; // dull, dirty hazard yellow
export const CRANE = 0x7a6026; // weathered crane yellow
export const LAMP_AMBER = 0xffa030;
export const LAMP_WHITE = 0xfff1d6;
export const SIGN_GLASS = 0x101418;
/** Muted shipping-container colours (rust, olive drab, navy grey, ochre). */
export const CONTAINERS = [0x4a3022, 0x343c2c, 0x2a323b, 0x56472a] as const;

// ── Style C shape helpers ──────────────────────────────────────────────────

/** Keep the part of `pts` with nx*x + ny*y <= d. */
export function clipHalf(pts: Pts, nx: number, ny: number, d: number): Pt[] {
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
export function stripe(pts: Pts, ang: number, off: number, w: number): Pt[] {
  const nx = Math.cos(ang), ny = Math.sin(ang);
  return clipHalf(clipHalf(pts, nx, ny, off + w / 2), -nx, -ny, -(off - w / 2));
}
export function fits(out: Pts, pts: Pts, m = 1): boolean {
  return pts.length >= 3 && pts.every(([x, y]) => polyEdgeDist(out, x, y) >= m);
}
/** mulberry32: a tiny seeded stream for the wear (grime, chips). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function poly(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], lift: number, bevel: number, extra?: Partial<PolyOp>): void {
  if (pts.length >= 3 && fits(c.frame ?? artFramePx(c.kindId, c.styleId), pts, 0)) c.polys.push({ pts, color, mat, lift, bevel, ...extra });
}
export function glow(c: StyleCtx, pts: Pts, color: number, alpha = 1): void {
  poly(c, pts, color, 'glow', -0.8, 1, { alpha });
}
/** A small hard work lamp, only where it lands on the structure. */
export function lamp(c: StyleCtx, x: number, y: number, r: number, color = LAMP_AMBER): void {
  if (polyEdgeDist(artFramePx(c.kindId, c.styleId), x, y) > r * 0.5) c.lit(x, y, r, color);
}

// ── Engineered parts ───────────────────────────────────────────────────────

/** The soot deck plate on the whole (symmetric chamfer) outline. */
export function deck(c: StyleCtx): Pts {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK, 'metal', 4, 3, { seams: 32, seamAngle: Math.PI / 2 });
  return out;
}

/** A solid core slab: a chamfered box, thick bevel, faceted roof, seams. */
export function core(c: StyleCtx, pts: Pts, color = SLAB, lift = 20, seamAngle = 0): Pts {
  const b = polyBounds(pts);
  const run = Math.min(b.w, b.h) * 0.1;
  poly(c, pts, color, 'metal', lift, Math.max(3, run * 0.5), { roof: [3, run], seams: Math.max(16, Math.min(b.w, b.h) * 0.2), seamAngle });
  return pts;
}

/** An exposed lattice girder from `a` to `b`, `w` deep (`trussPolys`). */
export function truss(c: StyleCtx, a: Pt, b: Pt, w: number, color = STEEL, lift = 8): void {
  trussPolys((pts, col, mat, l, bv) => poly(c, pts, col, mat, l, bv), a, b, w, color, lift);
}

/** A strut connector where two modules join: a bar with clamp collars. */
export function strut(c: StyleCtx, a: Pt, b: Pt, w: number, lift = 10): void {
  poly(c, strip(a, b, w), STEEL, 'metal', lift, 1.2);
  for (const [x, y] of [a, b]) poly(c, chamferBox(x - w * 0.8, y - w * 0.8, w * 1.6, w * 1.6, w * 0.4), SLAB_LIGHT, 'metal', lift + 2, 1);
}

/** A gantry walkway from `a` to `b`: grating deck, cross rungs, hand rails. */
export function walkway(c: StyleCtx, a: Pt, b: Pt, w: number, lift = 6): void {
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
export function scaffold(c: StyleCtx, x: number, y: number, w: number, h: number, step: number, lift = 8): void {
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
export function rivets(c: StyleCtx, a: Pt, b: Pt, step = 12, r = 2.2): void {
  rivetPolys((pts, col, mat, l, bv) => poly(c, pts, col, mat, l, bv), a, b, step, r, RIVET);
}

/** A weld seam (a raised bead) from `a` to `b`. */
export function weld(c: StyleCtx, a: Pt, b: Pt): void {
  poly(c, strip(a, b, 1.6), WELD, 'metal', 0.7, 0.5);
}

/** Wear over the box (x, y, w, h): soot and rust streaks running +y from
 *  seeded points, and a couple of stained patch panels. */
export function grime(c: StyleCtx, x: number, y: number, w: number, h: number, n: number, salt: number): void {
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
export function wornStripe(c: StyleCtx, pts: Pts, ang: number, off: number, w: number, salt: number): void {
  const band = stripe(pts, ang, off, w);
  if (band.length < 3) return;
  const tx = -Math.sin(ang), ty = Math.cos(ang);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of band) { const s = x * tx + y * ty; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const r = rng(c.seed * 104729 + salt);
  const out = artFramePx(c.kindId, c.styleId);
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
export const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
/** A stencilled hull number, top-left at (x, y), digits `h` tall, in worn
 *  paint (one seeded segment per digit is chipped short). */
export function stencil(c: StyleCtx, text: string, x: number, y: number, h: number): void {
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
export function frame(c: StyleCtx, x: number, y: number, w: number, h: number, d: number, lift = 9): void {
  truss(c, [x + d, y - d / 2], [x + w - d, y - d / 2], d, STEEL, lift);
  truss(c, [x + d, y + h + d / 2], [x + w - d, y + h + d / 2], d, STEEL, lift);
  truss(c, [x - d / 2, y + d], [x - d / 2, y + h - d], d, STEEL, lift);
  truss(c, [x + w + d / 2, y + d], [x + w + d / 2, y + h - d], d, STEEL, lift);
}
