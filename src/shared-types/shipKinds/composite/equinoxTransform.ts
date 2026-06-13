/**
 * Pure geometry transforms for porting Equinox composite-ship components into
 * the eqx-net catalogue coordinate frame (composite-ships Phase 1).
 *
 * Equinox (github.com/JanusBifrons/Equinox, `js/ships/...`) authors each ship
 * component as a list of `[x, y]` points where **+x = forward (nose)** on a
 * **canvas y-down** screen. eqx-net catalogue shapes are authored **Pixi-up**:
 * the nose points at **-y** (and +y is the tail). So a component point must be
 * re-framed by the linear map `(x, y) -> (y, -x)` AFTER its instance transform
 * (offset / scale / mirror) is applied.
 *
 * No runtime deps — pure TS, lives in `src/shared-types/` so server / core /
 * client can all read it without crossing a zone boundary.
 */

/**
 * Transform one Equinox component instance's raw points into eqx-net catalogue
 * (Pixi-up) local space.
 *
 * Each Equinox component instance is `{ points: [x, y][], offset, scale, mirror }`:
 *  - `mirror` reflects the component across its forward axis (so a left/right
 *    pair is authored once) — in Equinox-forward space (+x forward, y-down)
 *    that is a flip of the cross-axis `y`.
 *  - The whole component is uniformly scaled by `scale`.
 *  - Equinox's `Component.adjustCenter` (on by default) re-centres the scaled
 *    points on their CENTROID, and the instance is then positioned so that
 *    centroid sits at `offset`. So the offset places the component's CENTROID,
 *    not its `(0,0)` origin — this is load-bearing: skipping it spreads the
 *    parts out (pads drift forward, wings drift apart).
 *
 * Order: mirror (cross-axis) -> scale -> subtract centroid -> translate by
 * offset (all in Equinox +x-forward / y-down space), THEN re-frame to Pixi-up
 * via the final `(x, y) -> (y, -x)` map. Re-framing LAST means the offset is
 * supplied in the same Equinox frame as `debug.js`'s `createComponents`.
 *
 * @param rawPoints Equinox component `createPoints()` output, `[x, y][]`.
 * @param offset    `[ox, oy]` where the component CENTROID lands (Equinox frame).
 * @param scale     uniform component scale.
 * @param mirror    reflect across the forward axis (flip cross-axis y).
 * @param centroidSource Optional point-set whose centroid to centre on instead
 *   of `rawPoints` — used for a SUB-feature (e.g. the cockpit dome) that must
 *   stay glued to its PARENT component's frame rather than centre on itself.
 *   Scaled/mirrored with the same `scale`/`mirror` so it shares the instance.
 * @returns the points in eqx-net Pixi-up catalogue space, `[x, y][]`.
 */
export function equinoxPartPoints(
  rawPoints: ReadonlyArray<readonly [number, number]>,
  offset: readonly [number, number],
  scale: number,
  mirror: boolean,
  centroidSource?: ReadonlyArray<readonly [number, number]>,
): [number, number][] {
  // Apply mirror (cross-axis y) + uniform scale to a point set.
  const scaleMirror = (
    pts: ReadonlyArray<readonly [number, number]>,
  ): [number, number][] =>
    pts.map(([px, py]) => [px * scale, (mirror ? -py : py) * scale]);

  const scaled = scaleMirror(rawPoints);
  // Centroid to centre on — this part's own points, or a parent's (sub-feature).
  const centrePts = scaleMirror(centroidSource ?? rawPoints);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of centrePts) {
    cx += x;
    cy += y;
  }
  cx /= centrePts.length;
  cy /= centrePts.length;

  const out: [number, number][] = [];
  for (const [x, y] of scaled) {
    const ex = x - cx + offset[0]; // centroid -> offset, in Equinox frame
    const ey = y - cy + offset[1];
    // Re-frame Equinox (+x forward, y-down) -> Pixi-up (-y forward): (x,y)->(y,-x).
    out.push([ey, -ex]);
  }
  return out;
}

/**
 * Andrew's monotone-chain convex hull. Deterministic: input is sorted by
 * `x` then `y` before the chains are built, and collinear points are dropped
 * (`cross <= 0` rejects right turns AND straight runs), so the result is the
 * minimal set of corner vertices in counter-clockwise order.
 *
 * Used to derive a composite ship's gross collision `hull` from the union of
 * every part's points — the single outline the physics collider + hitscan see
 * (per-part live collision is intentionally NOT modelled).
 *
 * @param points the union of all part points, `[x, y][]`.
 * @returns the convex hull corners, counter-clockwise, `[x, y][]`.
 */
export function convexHull(
  points: ReadonlyArray<readonly [number, number]>,
): [number, number][] {
  const n = points.length;
  if (n < 3) return points.map(([x, y]) => [x, y]);

  // Sort by x, then y (deterministic ordering).
  const pts = points
    .map(([x, y]) => [x, y] as [number, number])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  // 2D cross product of OA x OB (origin O). > 0 = counter-clockwise turn.
  const cross = (
    o: [number, number],
    a: [number, number],
    b: [number, number],
  ): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  // Drop each chain's last point (it's the first point of the other chain).
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
