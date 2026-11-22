/**
 * Cable clearance (owner rule: cables never cross, never overlap). The
 * narrow phase of `cableCrossesExisting` (`cableCurve.ts`): do two flattened
 * cables come closer than `clearance` anywhere? A proper crossing (distance
 * 0), a collinear overlap and two cables running side by side closer than a
 * cable body all count. Kept out of `cableCurve.ts` (god-file ceiling).
 * Allocation-free.
 */

/** A polyline's axis-aligned box (structurally `CableBox`). */
export interface ClearanceBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** Twice the signed area of (p, q, r): > 0 left turn, < 0 right turn. */
function orient(px: number, py: number, qx: number, qy: number, rx: number, ry: number): number {
  return (qx - px) * (ry - py) - (qy - py) * (rx - px);
}

/** Squared distance from (px, py) to segment (ax, ay)-(bx, by). */
function pointSeg2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

/** Squared distance between segments ab and cd: 0 when they cross (half-open
 *  sides: passing exactly through a vertex crosses), else the closest of the
 *  four endpoint-to-segment distances. */
export function segSegDist2(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if ((orient(ax, ay, bx, by, cx, cy) > 0) !== (orient(ax, ay, bx, by, dx, dy) > 0)
    && (orient(cx, cy, dx, dy, ax, ay) > 0) !== (orient(cx, cy, dx, dy, bx, by) > 0)) return 0;
  let m = pointSeg2(ax, ay, cx, cy, dx, dy);
  let d = pointSeg2(bx, by, cx, cy, dx, dy); if (d < m) m = d;
  d = pointSeg2(cx, cy, ax, ay, bx, by); if (d < m) m = d;
  d = pointSeg2(dx, dy, ax, ay, bx, by); if (d < m) m = d;
  return m;
}

/**
 * Does any of `p`'s `segs` segments come within `clearance` of any of `q`'s
 * (box `qb`)? Each `p` segment's box, padded by `clearance`, is tested
 * against `qb`, then against each `q` segment's box, before the distance
 * test; each distance test counts in `stats.segTests` (a count gate, never a
 * wall clock). Allocation-free.
 */
export function polylinesWithin(
  p: Float64Array, q: Float64Array, qb: ClearanceBox, segs: number, clearance: number, stats: { segTests: number },
): boolean {
  const c2 = clearance * clearance;
  for (let i = 0; i < segs; i++) {
    const k = i * 2;
    const ax = p[k]!, ay = p[k + 1]!, bx = p[k + 2]!, by = p[k + 3]!;
    const sx0 = Math.min(ax, bx) - clearance, sx1 = Math.max(ax, bx) + clearance;
    const sy0 = Math.min(ay, by) - clearance, sy1 = Math.max(ay, by) + clearance;
    if (sx1 < qb.x0 || sx0 > qb.x1 || sy1 < qb.y0 || sy0 > qb.y1) continue;
    for (let j = 0; j < segs; j++) {
      const m = j * 2;
      const cx = q[m]!, cy = q[m + 1]!, dx = q[m + 2]!, dy = q[m + 3]!;
      if (Math.max(cx, dx) < sx0 || Math.min(cx, dx) > sx1 || Math.max(cy, dy) < sy0 || Math.min(cy, dy) > sy1) continue;
      stats.segTests++;
      if (segSegDist2(ax, ay, bx, by, cx, cy, dx, dy) < c2) return true;
    }
  }
  return false;
}
