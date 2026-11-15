/**
 * The wreck glow's strip geometry (build-time, plus the in-place
 * `writeStrip`): how far a cut's glow strip may reach and stay on the piece
 * AS DRAWN, and where along a cut edge the drawn hull is.
 *
 * A capital's collider `hull` is the convex hull of its parts (the side
 * barbettes stick out), so a wreck piece's outline spans empty space beside
 * the drawn body; its art is transparent there. A glow strip drawn to the
 * outline sat out there as "white bars stuck onto the hull edge" (hostile
 * film review 2026-11-15, railgun take 7). So the strip is held to the
 * piece's outline AND the drawn parts (`shipParts`, the art's own source),
 * and each cut edge glows only along its drawn span (`drawnSpan`).
 * Detail: docs/architecture/capital-destruction.md "Cut glow colours".
 */
import { getShipKind, isShipKindId } from '../../../shared-types/shipKinds.js';
import { shipParts } from '../art/fields.js';

/** A point test in a piece's body-local math-up frame. */
export type InsideTest = (x: number, y: number) => boolean;

/** The chamfers a kill cut's strip end may take (× its width): from
 *  `CHAMFER_MIN` (all but square, where it fits: most hull corners of a side
 *  cut are ~90°; a truly square end there lies ON the hull side and fails
 *  the inside test) doubling to `CHAMFER_MAX`, the shortest that fits.
 *  Always starting at 1 (45°) gave every end a long bevel. */
const CHAMFER_MIN = 1 / 32;
const CHAMFER_MAX = 8;
/** The chamfer ratio `insideWidth` chose (build-time scratch; 0 = square). */
let _chamferRatio = 0;
/** The chamfer ratio the last `insideWidth` call chose (0 = square). */
export function lastChamferRatio(): number {
  return _chamferRatio;
}

/** Four corners of a strip on one side of the edge (px,py) → (qx,qy): from
 *  the edge to `wp` / `wq` (at each end) along the unit normal (nx,ny).
 *  Corners 0 and 3 at the near end (on the edge: 3), 1 and 2 at the far end
 *  (on the edge: 2), the U and V layout `writeGlow` relies on. Chamfer (a
 *  kill cut's ends): the outer corners step in along the edge by `cp` / `cq`
 *  × their width (≤ half the edge), so the strip's end fits the hull corner
 *  it starts in (ratio 1: a 45° end). 0: a square end. In place. */
export function writeStrip(
  pos: Float32Array, v0: number, px: number, py: number, qx: number, qy: number,
  nx: number, ny: number, wp: number, wq: number, rp = 0, rq = 0,
): void {
  const o = v0 * 2;
  let cp = 0, cq = 0, dx = 0, dy = 0;
  if (rp > 0 || rq > 0) {
    const len = Math.hypot(qx - px, qy - py);
    if (len > 1e-6) { dx = (qx - px) / len; dy = (qy - py) / len; cp = Math.min(wp * rp, len / 2); cq = Math.min(wq * rq, len / 2); }
  }
  pos[o] = px + nx * wp + dx * cp; pos[o + 1] = py + ny * wp + dy * cp;
  pos[o + 2] = qx + nx * wq - dx * cq; pos[o + 3] = qy + ny * wq - dy * cq;
  pos[o + 4] = qx; pos[o + 5] = qy;
  pos[o + 6] = px; pos[o + 7] = py;
}

/** How far (≤ `w`) a strip may reach from outline point (x, y) along the
 *  unit normal (mx, my) and stay `inside` (math-up). Halved until the
 *  strip's tip and middle are inside; 0 at a sharp corner. Build-time. */
export function insideWidth(
  inside: InsideTest, x: number, y: number, mx: number, my: number, w: number,
  /** A chamfered strip (`writeStrip`): the unit direction along the edge
   *  into it, and the edge's length; (0, 0) for a square end. */
  dx = 0, dy = 0, len = 0,
): number {
  const chamfer = dx !== 0 || dy !== 0;
  for (let k = 0; k < 6; k++, w *= 0.5) {
    // Widest first; at each width the shortest chamfer that fits.
    for (let r = chamfer ? CHAMFER_MIN : 0; r <= (chamfer ? CHAMFER_MAX : 0); r = chamfer ? r * 2 : Infinity) {
      const c = Math.min(w * r, len / 2);
      const tx = x + mx * w + dx * c, ty = y + my * w + dy * c;
      if (inside(tx, ty) && inside((x + tx) * 0.5, (y + ty) * 0.5)) { _chamferRatio = r; return w; }
    }
  }
  _chamferRatio = 0;
  return 0;
}

/** Even-odd point-in-polygon. */
export function pointInRing(ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const STRIP_SAMPLES = 16;

/** Whether the strip from edge (ax,ay) → (bx,by) out to `wa` / `wb` along
 *  the normal (mx, my) lies `inside` (math-up): its far side and its
 *  middle, sampled along the edge. Build-time. */
export function stripInside(
  inside: InsideTest, ax: number, ay: number, bx: number, by: number,
  mx: number, my: number, wa: number, wb: number, ra = 0, rb = 0,
): boolean {
  // The strip's outer edge (`writeStrip`'s corners 0 → 1), sampled with
  // the edge point it stands on.
  let ca = 0, cb = 0, dx = 0, dy = 0;
  if (ra > 0 || rb > 0) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len > 1e-6) { dx = (bx - ax) / len; dy = (by - ay) / len; ca = Math.min(wa * ra, len / 2); cb = Math.min(wb * rb, len / 2); }
  }
  const oax = ax + mx * wa + dx * ca, oay = ay + my * wa + dy * ca;
  const obx = bx + mx * wb - dx * cb, oby = by + my * wb - dy * cb;
  for (let i = 0; i <= STRIP_SAMPLES; i++) {
    const f = i / STRIP_SAMPLES, w = wa + (wb - wa) * f;
    if (!(w > 0)) continue;
    const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
    const ox = oax + (obx - oax) * f, oy = oay + (oby - oay) * f;
    if (!inside(ox, oy) || !inside((x + ox) * 0.5, (y + oy) * 0.5)) return false;
  }
  return true;
}

// ── The hull as drawn ──────────────────────────────────────────────────────

interface DrawnPart { ring: Array<{ x: number; y: number }>; x0: number; y0: number; x1: number; y1: number }
const _drawn = new Map<string, DrawnPart[] | null>();

/** A composite kind's drawn parts (hull frame, math-up; null for a polygon
 *  kind, whose outline IS its drawing). Cached per kind. */
function drawnParts(kind: string): DrawnPart[] | null {
  let d = _drawn.get(kind);
  if (d !== undefined) return d;
  d = null;
  if (isShipKindId(kind)) {
    const k = getShipKind(kind);
    if (k.shape.kind === 'composite') {
      d = shipParts(k).map(({ pts }) => {
        const ring = pts.map(([x, y]) => ({ x, y }));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        return { ring, x0, y0, x1, y1 };
      });
    }
  }
  _drawn.set(kind, d);
  return d;
}

/** Whether hull-frame (x, y) is on `kind`'s drawn hull (always, for a
 *  polygon kind). Build-time. */
export function onDrawnHull(kind: string, x: number, y: number): boolean {
  const parts = drawnParts(kind);
  if (parts === null) return true;
  for (const p of parts) if (x >= p.x0 && x <= p.x1 && y >= p.y0 && y <= p.y1 && pointInRing(p.ring, x, y)) return true;
  return false;
}

const SPAN_SAMPLES = 48;
const _span = { t0: 0, t1: 1 };

/** The longest stretch of the edge (x0,y0) → (x1,y1) (math-up) whose points
 *  a hair `d` along (mx, my) pass `on`, as fractions along the edge
 *  (t0 > t1: none). A reused scratch; read it at once. Build-time. */
export function drawnSpan(
  on: InsideTest, x0: number, y0: number, x1: number, y1: number, mx: number, my: number, d: number,
): { t0: number; t1: number } {
  const at = (t: number): boolean => on(x0 + (x1 - x0) * t + mx * d, y0 + (y1 - y0) * t + my * d);
  let best = -1, bestLen = 0, run = -1;
  for (let i = 0; i <= SPAN_SAMPLES + 1; i++) {
    const hit = i <= SPAN_SAMPLES && at(i / SPAN_SAMPLES);
    if (hit && run < 0) run = i;
    if (!hit && run >= 0) { if (i - run > bestLen) { bestLen = i - run; best = run; } run = -1; }
  }
  if (best < 0) { _span.t0 = 1; _span.t1 = 0; return _span; }
  // Refine each end between its last miss and first hit (bisection).
  const edgeOf = (inT: number, outT: number): number => {
    if (outT < 0 || outT > 1) return inT;
    for (let k = 0; k < 10; k++) { const m = (inT + outT) / 2; if (at(m)) inT = m; else outT = m; }
    return inT;
  };
  const last = best + bestLen - 1;
  _span.t0 = edgeOf(best / SPAN_SAMPLES, (best - 1) / SPAN_SAMPLES);
  _span.t1 = edgeOf(last / SPAN_SAMPLES, (last + 1) / SPAN_SAMPLES);
  return _span;
}
