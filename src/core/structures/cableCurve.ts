/**
 * Cable curve (structure restyle stage 4, 0d "cable sockets", slice 3).
 *
 * A cable runs socket to socket as one cubic Bezier: from socket A out along
 * A's outward normal, bending round to come into socket B along B's normal
 * (the owner-approved concept page). Control points sit `k` along each normal,
 * `k = min(CABLE_TAIL_MAX, d * CABLE_TAIL_FRACTION)` for socket distance `d`;
 * a connector end (small, round, takes a cable from any side) uses a short
 * tail `min(CABLE_SHORT_TAIL, k)`.
 *
 * `flattenCableCurve` turns the curve into a fixed `CABLE_CURVE_SEGMENTS`
 * polyline in a caller-owned Float64Array plus its box, allocation-free (the
 * build preview runs this every frame on a phone). `isCablePolylineBlocked`
 * is the polyline form of `isConnectionLineBlocked` (Grid.ts): same nodes and
 * obstacles count, the two endpoints are ignored, and it reuses the same
 * segment tests, with the polyline's box as a broad phase. It lives here, not
 * in Grid.ts, to keep Grid.ts under the god-file ceiling.
 *
 * Nothing calls these yet: `canConnect` switches over in a later slice.
 */
import { segmentHitsObstacle, segmentIntersectsAabb, type GridNode, type GridObstacle } from './Grid.js';

/** Segments in a flattened cable curve (points = segments + 1). */
export const CABLE_CURVE_SEGMENTS = 12;
/** Float64Array length a flattened curve needs: (x, y) per point. */
export const CABLE_CURVE_FLOATS = (CABLE_CURVE_SEGMENTS + 1) * 2;
/** Longest control-point tail along a socket normal (world units). */
export const CABLE_TAIL_MAX = 260;
/** Tail as a share of the socket-to-socket distance. */
export const CABLE_TAIL_FRACTION = 0.35;
/** A connector end's short tail cap (world units). */
export const CABLE_SHORT_TAIL = 40;

/** A world-space socket: point plus unit outward normal. Structurally matches
 *  `MutStructureSocket` / `StructureSocket` (shared-types). */
export interface CableEnd {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

/** Caller-owned scratch box for a flattened curve. */
export interface CableBox { x0: number; y0: number; x1: number; y1: number }

/** A fresh scratch box (allocate once, reuse). */
export function makeCableBox(): CableBox {
  return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/**
 * Flatten the socket-to-socket curve into `out` (length ≥ `CABLE_CURVE_FLOATS`;
 * x0,y0,x1,y1,…) and its axis-aligned box into `box`. `aShort` / `bShort` mark
 * a connector end (short tail). The first point is exactly socket A, the last
 * exactly socket B, and the curve leaves A along A's normal and enters B
 * against B's normal. Allocation-free.
 */
export function flattenCableCurve(
  a: CableEnd, aShort: boolean,
  b: CableEnd, bShort: boolean,
  out: Float64Array,
  box: CableBox,
): void {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(CABLE_TAIL_MAX, d * CABLE_TAIL_FRACTION);
  const ka = aShort ? Math.min(CABLE_SHORT_TAIL, k) : k;
  const kb = bShort ? Math.min(CABLE_SHORT_TAIL, k) : k;
  const p0x = a.x, p0y = a.y;
  const p1x = a.x + a.nx * ka, p1y = a.y + a.ny * ka;
  const p2x = b.x + b.nx * kb, p2y = b.y + b.ny * kb;
  const p3x = b.x, p3y = b.y;
  let x0 = p0x, y0 = p0y, x1 = p0x, y1 = p0y;
  out[0] = p0x;
  out[1] = p0y;
  for (let i = 1; i < CABLE_CURVE_SEGMENTS; i++) {
    const t = i / CABLE_CURVE_SEGMENTS;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    const x = w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x;
    const y = w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y;
    out[i * 2] = x;
    out[i * 2 + 1] = y;
    if (x < x0) x0 = x; else if (x > x1) x1 = x;
    if (y < y0) y0 = y; else if (y > y1) y1 = y;
  }
  const last = CABLE_CURVE_SEGMENTS * 2;
  out[last] = p3x;
  out[last + 1] = p3y;
  if (p3x < x0) x0 = p3x; else if (p3x > x1) x1 = p3x;
  if (p3y < y0) y0 = p3y; else if (p3y > y1) y1 = p3y;
  box.x0 = x0;
  box.y0 = y0;
  box.x1 = x1;
  box.y1 = y1;
}

/** Narrow-phase counter (count gate for tests and the scale bench): how many
 *  nodes / obstacles passed the box broad phase and got per-segment tests.
 *  Callers may reset `narrow` to 0; nothing else reads it. */
export const CABLE_BLOCK_STATS = { narrow: 0 };

/** Does any segment of the flattened polyline cross the box? */
function polylineHitsAabb(poly: Float64Array, minX: number, minY: number, maxX: number, maxY: number): boolean {
  for (let i = 0; i < CABLE_CURVE_SEGMENTS; i++) {
    const j = i * 2;
    if (segmentIntersectsAabb(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, minX, minY, maxX, maxY)) return true;
  }
  return false;
}

/**
 * The polyline form of `isConnectionLineBlocked`: true if the flattened cable
 * (`poly`, from `flattenCableCurve`, with its `box`) passes through any node's
 * footprint box other than `a` / `b`, or through any `obstacle`
 * (`segmentHitsObstacle`, parts narrow phase included). A node or obstacle
 * whose box misses the curve's box is skipped before the per-segment tests.
 * `obstacles` is optional, as in `isConnectionLineBlocked`. Allocation-free.
 */
export function isCablePolylineBlocked(
  a: GridNode,
  b: GridNode,
  poly: Float64Array,
  box: CableBox,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles?: readonly GridObstacle[],
): boolean {
  for (const n of nodes.values()) {
    if (n.id === a.id || n.id === b.id) continue;
    const hw = n.halfW ?? n.radius, hh = n.halfH ?? n.radius;
    const minX = n.x - hw, maxX = n.x + hw, minY = n.y - hh, maxY = n.y + hh;
    if (maxX < box.x0 || minX > box.x1 || maxY < box.y0 || minY > box.y1) continue;
    CABLE_BLOCK_STATS.narrow++;
    if (polylineHitsAabb(poly, minX, minY, maxX, maxY)) return true;
  }
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]!;
      const r = o.radius;
      if (o.x + r < box.x0 || o.x - r > box.x1 || o.y + r < box.y0 || o.y - r > box.y1) continue;
      CABLE_BLOCK_STATS.narrow++;
      for (let s = 0; s < CABLE_CURVE_SEGMENTS; s++) {
        const j = s * 2;
        if (segmentHitsObstacle(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, o)) return true;
      }
    }
  }
  return false;
}
