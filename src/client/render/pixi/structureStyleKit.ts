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
import { structureOutline } from '../../../shared-types/structureKinds.js';
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
  /** Owner livery on (`?structLivery=1`): push sigil slots and bands. */
  livery: boolean;
  polys: PolyOp[];
  sigils: StyleSigilSlot[];
  bands: StyleBand[];
  /** Add a lamp (skipped when unpowered). */
  lit(x: number, y: number, r: number, color: number): void;
}

export type StyleDrawer = (c: StyleCtx) => void;

/** A structure style direction: a drawer per kind it restyles. Kinds without
 *  one keep today's art. */
export interface StructureStyleDef {
  /** Human name (art lab / Artifact captions). */
  label: string;
  kinds: Readonly<Partial<Record<string, StyleDrawer>>>;
}

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
