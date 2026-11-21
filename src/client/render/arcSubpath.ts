/**
 * Add a circular arc to a Pixi path as its own open subpath, safe to stroke.
 *
 * Never write `g.moveTo(arc start); g.arc(...)`: Pixi v8's `arc()` pushes its
 * own start point onto the current subpath, so the stroke polygon begins with
 * two identical points, `buildLine` divides the first segment's normal by a
 * zero length and emits NaN vertices, and a phone GPU draws those at the
 * Graphics' local origin: a long stray line to the arc (docs/LESSONS.md). A
 * bare `g.arc()` is no better after an earlier stroke or fill, which leaves
 * the path's last point behind, so the arc grows a line from there.
 *
 * This starts a fresh subpath at the arc's first point (`moveTo`, which
 * replaces any leftover point) and walks the arc with `lineTo`, which skips
 * duplicate points. Several calls before one `stroke()` give separate arcs
 * (dashes). The sweep runs clockwise on screen from `a0` to `a1` (positive
 * angle direction, like `arc(..., false)`), wrapping past 2π like Pixi does;
 * the segment count matches Pixi's `buildArc`. Allocates nothing (#14).
 */
export interface ArcPathSink {
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
}

export function arcSubpath<T extends ArcPathSink>(g: T, cx: number, cy: number, r: number, a0: number, a1: number): T {
  let sweep = a1 - a0;
  if (sweep < 0) sweep += Math.PI * 2;
  const steps = Math.max(6, Math.floor(6 * Math.cbrt(r) * (sweep / Math.PI)));
  g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return g;
}
