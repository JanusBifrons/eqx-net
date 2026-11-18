/**
 * The cut-field test room's rocks, rebuilt from the seed (field rocks never
 * ride the wire: server and client cut the same chunks). Shared by the
 * cut-field specs.
 */
import { rocksInChunk, CHUNK_SIZE, FIELD_COLLIDER_SIMPLIFY } from '../../../src/core/terrain/fieldLayout';
// The same field options as `cutFieldOpts` (chunkStreamer.ts holds a class
// with parameter properties, which Playwright's strip-only loader can't load).
import { getShipKind } from '../../../src/shared-types/shipKinds';

export type FieldPoint = { x: number; y: number };
type P = FieldPoint;

export function convexHull(pts: readonly P[]): P[] {
  const a = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: P, p: P, q: P): number => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const lo: P[] = [], hi: P[] = [];
  for (const p of a) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop(); lo.push(p); }
  for (const p of a.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2]!, hi[hi.length - 1]!, p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1)); // counter-clockwise
}
/** How far `p` is inside the CCW convex polygon (<= 0 = outside). */
export function depthInside(h: readonly P[], p: P): number {
  let d = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i]!, b = h[(i + 1) % h.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    d = Math.min(d, ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len);
  }
  return d;
}
/** How far `p` is inside the (possibly concave) polygon (<= 0 = outside). */
export function depthInsideOutline(poly: readonly P[], p: P): number {
  let inside = false, d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const ex = b.x - a.x, ey = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey));
  }
  return inside ? d : -d;
}

export interface FieldRock { outline: P[]; hull: P[]; slack: number }

/** Every field rock within a chunk of `at` (seed `look`): its drawn outline,
 *  its convex hull, and how far its collider may cut into the outline
 *  (`FIELD_COLLIDER_SIMPLIFY` × the radius of a circle of its area). */
export function fieldRocksNear(at: P, seed = 'look'): FieldRock[] {
  const o = { seed, battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2 };
  const cx = Math.floor(at.x / CHUNK_SIZE), cy = Math.floor(at.y / CHUNK_SIZE);
  const out: FieldRock[] = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const r of rocksInChunk(o, cx + i, cy + j)) {
    let a2 = 0;
    for (let k = 0; k < r.verts.length; k++) { const a = r.verts[k]!, b = r.verts[(k + 1) % r.verts.length]!; a2 += a.x * b.y - b.x * a.y; }
    out.push({ outline: r.verts, hull: convexHull(r.verts), slack: FIELD_COLLIDER_SIMPLIFY * Math.sqrt(Math.abs(a2) / 2 / Math.PI) });
  }
  return out;
}
