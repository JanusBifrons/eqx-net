/**
 * Convex decomposition for ship hull polygons (2026-05-28).
 *
 * Why this exists: shield-down ship colliders must EXACTLY match the
 * rendered silhouette. Most ships have at least one reflex vertex (the
 * concave fighter/scout/interceptor tail, the Crossguard T's twin
 * reflexes at the crossbar-stem junction). Rapier's `convexHull`
 * collapses concave input by filling the notch — wrong silhouette,
 * wrong contact pairs. So we decompose each catalogue polygon into a
 * set of convex pieces at module load, attach one `convexHull` collider
 * per piece to the body (implicit compound), and the player sees + the
 * physics sees the same shape.
 *
 * Engine: `poly-decomp` (MIT, ~3 KB, port of Mark Bayazit's algorithm,
 * 2014-present, used by p2.js). Deterministic for fixed input — same
 * polygon ⇒ same parts on every Node and Chromium load. Precomputed
 * ONCE at module load from the frozen catalogue (zero per-tick alloc;
 * core CLAUDE.md physics rule).
 *
 * Replaces the in-house ear-clipping triangulator that lived in
 * `triangulate.ts`. The replacement is a behavioural superset:
 *  - Convex parts (typically 1–3 per kind) instead of triangles
 *    (n − 2 per kind). Fewer Rapier colliders per body ⇒ fewer broadphase
 *    pairs, less contact churn.
 *  - Same `Vec2[]` output type per piece; `rayHitsConvexPolygon` already
 *    accepts arbitrary-vertex convex polygons (slab-clip is loop-agnostic).
 *  - Same per-kind frozen lookup keyed by `ShipKindId`.
 *
 * Winding contract (unchanged from the triangulator): every emitted
 * sub-polygon is CCW in standard math orientation. `rayHitsConvexPolygon`'s
 * outward edge normal `(edge.y, -edge.x)` only points OUTWARD for CCW
 * polygons — feed it CW and every half-space inverts and hits silently
 * fail. The catalogue's `points` are authored Pixi-up (CW in standard
 * orientation); `poly-decomp.makeCCW` re-orients the input.
 */
import decomp from 'poly-decomp';
import type { Vec2 } from '../swarm/asteroidShape.js';
import {
  SHIP_KINDS,
  DEFAULT_SHIP_KIND,
  type ShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import { shipHullOutline, shipShapeScale } from './shipHullOutline.js';

/** One convex sub-polygon of a ship hull. Always CCW (positive signed area). */
export type ConvexPart = readonly Vec2[];

/** Shoelace signed area. CCW (standard math orientation) ⇒ positive.
 *  Retained from the triangulator era — tests use it for area-conservation
 *  invariants and a couple of pure-geometry callers still need it. */
export function signedArea(poly: ReadonlyArray<Vec2>): number {
  const n = poly.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

/**
 * Catalogue `points` → entity-local Vec2[] with `shape.scale` applied
 * AND Y-flipped from Pixi-up authoring to math-up (Rapier's frame).
 *
 * Why the Y-flip (2026-05-28 — Crossguard scale-10 smoke surfaced the
 * latent bug): catalogue polygons are authored Pixi-up (Y goes DOWN on
 * screen, nose at negative Y) — this is what `buildShipGfxFromShape`
 * draws directly. But Rapier is a math-frame engine (+Y up; standard
 * CCW rotation). The renderer's `sprite.y = -ship.y` converts the
 * BODY position from math-up to Pixi-down, but the POLYGON vertices
 * weren't being Y-flipped to match — so a body at game (X, Y) had:
 *
 *   - VISUAL polygon vertex (Vx, Vy) drawn at screen (sprite.x + Vx,
 *     sprite.y + Vy) = (X + Vx, -Y + Vy).
 *   - COLLIDER vertex (cx, cy) in math-frame world (X + cx, Y + cy),
 *     after Y-flip for screen comparison: (X + cx, -Y - cy).
 *
 * For visual = collider at the same screen position, we need Vy = -cy
 * (opposite signs). Y-flipping at this seam (cy = -Vy = -catalog.y)
 * makes the collider polygon match the rendered silhouette exactly.
 *
 * Crossguard at scale 10 made the latent ~32 px mismatch on
 * fighter/scout/interceptor explode into ~320 px (entirely outside the
 * silhouette) and the smoke "100% off" was unmissable.
 *
 * The same math-up convention is what `mountWorldOrigin` already uses
 * for mount positions (renderer flips them at `turret.y = -mount.localY`).
 * Polygon and mount are now consistent.
 */
export function shipShapeToPolygon(kind: ShipKind): Vec2[] {
  const s = shipShapeScale(kind);
  return shipHullOutline(kind).map(([x, y]) => ({ x: x * s, y: -y * s }));
}

/**
 * Drop vertices that lie on the straight edge between their neighbours
 * (zero-area corner). poly-decomp can leave such redundant vertices on a
 * part's edge when the SOURCE polygon has three+ collinear boundary points —
 * e.g. the Crossguard's clean-T crossbar bottom (`(±14,-10)` outer corners
 * collinear with the `(±4,-10)` reflex corners). A collinear vertex has a
 * zero cross-product, so a strict convexity check (`isConvexCcw`) rejects it,
 * AND a fan triangle anchored on it is degenerate (zero area). Removing them
 * is shape-PRESERVING (area + outline unchanged) and yields minimal,
 * strictly-convex parts. O(n²) but n ≤ ~8 and this runs once at module load.
 */
function stripCollinear(poly: Vec2[]): Vec2[] {
  const EPS = 1e-6;
  const pts = poly.slice();
  let i = 0;
  while (pts.length > 3 && i < pts.length) {
    const n = pts.length;
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % n]!;
    const crossZ = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(crossZ) < EPS) {
      pts.splice(i, 1); // drop collinear b; re-examine this index (next vertex)
    } else {
      i++;
    }
  }
  return pts;
}

/** Drop the vertices of closed ring `pts` that lie within `eps` of the chord
 *  between the kept ones (Ramer–Douglas–Peucker), in place order. Split at
 *  vertex 0 and the vertex farthest from it. Pure arithmetic: same input,
 *  same output on every machine. */
function simplifyRing(pts: [number, number][], eps: number): [number, number][] {
  const n = pts.length;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i]![0] - pts[0]![0]) ** 2 + (pts[i]![1] - pts[0]![1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep: boolean[] = new Array<boolean>(n).fill(false);
  keep[0] = keep[far] = true;
  const stack: number[] = [0, far, far, n];
  while (stack.length > 0) {
    const b = stack.pop()!, a = stack.pop()!;
    const A = pts[a % n]!, B = pts[b % n]!, dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    let best = -1, bd = eps;
    for (let k = a + 1; k < b; k++) {
      const q = pts[k % n]!;
      const d = Math.abs((q[0] - A[0]) * dy - (q[1] - A[1]) * dx) / len;
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best % n] = true; stack.push(a, best, best, b); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Convex parts (CCW) of any simple polygon, for a collider that follows its
 *  dents. With `simplify` > 0 the outline is first thinned (`simplifyRing`):
 *  bumps and dents shallower than `simplify` go, which keeps the part count
 *  small for rough outlines (cut-field rocks). Null when the outline crosses
 *  itself or the split fails its check (every part convex, the areas adding
 *  up): the caller keeps its single convex hull. Deterministic for the same
 *  float64 input, so both sides of a two-sided collider build the same parts
 *  (#15). Generation-time only (allocates). */
export function convexParts(poly: readonly Vec2[], simplify = 0): Vec2[][] | null {
  let pts: [number, number][] = poly.map((p) => [p.x, p.y]);
  decomp.makeCCW(pts);
  if (simplify > 0) pts = simplifyRing(pts, simplify);
  if (pts.length < 3 || !decomp.isSimple(pts)) return null;
  const whole = signedArea(pts.map(([x, y]) => ({ x, y })));
  if (!(whole > 0)) return null;
  const parts = decomp.quickDecomp(pts).map((part) => stripCollinear(part.map(([x, y]): Vec2 => ({ x, y }))));
  if (parts.length === 0) return null;
  let sum = 0;
  for (const part of parts) {
    if (part.length < 3 || !isConvexCcwLoose(part)) return null;
    sum += signedArea(part);
  }
  return Math.abs(sum - whole) <= whole * 1e-6 ? parts : null;
}

/** Every corner turns left (or is straight), so the part is convex and CCW. */
function isConvexCcwLoose(p: readonly Vec2[]): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i]!, b = p[(i + 1) % n]!, c = p[(i + 2) % n]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9) return false;
  }
  return true;
}

/** Decompose one ShipKind's scaled polygon into convex parts. Deterministic. */
function decomposeForKind(kind: ShipKind): readonly ConvexPart[] {
  const poly = shipShapeToPolygon(kind);
  // Clone into the tuple form poly-decomp wants AND mutates. Never hand the
  // caller's array to the library — `makeCCW` flips winding in-place and
  // would silently scramble whoever else might iterate the kind's points
  // (the renderer reads `kind.shape.points` directly, with Pixi-up CW
  // winding baked in).
  const pts: [number, number][] = poly.map((p) => [p.x, p.y]);
  decomp.makeCCW(pts);
  // poly-decomp.quickDecomp emits an Array<Polygon>; strip collinear vertices
  // (clean-T crossbar bottom), then freeze each part + the outer array so a
  // downstream caller can never inadvertently mutate the precomputed lookup.
  const parts = decomp.quickDecomp(pts);
  return Object.freeze(
    parts.map(
      (part) =>
        Object.freeze(
          stripCollinear(part.map(([x, y]): Vec2 => ({ x, y }))),
        ) as ConvexPart,
    ),
  );
}

function buildAll(): Record<ShipKindId, readonly ConvexPart[]> {
  const out = {} as Record<ShipKindId, readonly ConvexPart[]>;
  for (const kind of Object.values(SHIP_KINDS)) {
    out[kind.id] = decomposeForKind(kind);
  }
  return out;
}

/** Frozen per-kind convex-part decomposition. Built once at module load
 *  on the frozen catalogue; key = `ShipKindId`. */
export const SHIP_KIND_COLLISION_PARTS: Readonly<
  Record<ShipKindId, readonly ConvexPart[]>
> = Object.freeze(buildAll());

/**
 * Convex parts for a (possibly unknown) kind id. Falls back to the catalogue
 * default — same forgiving stance as `getShipKind`, so a malformed wire
 * value can never crash the collision path.
 */
export function shipCollisionParts(
  id: string | null | undefined,
): readonly ConvexPart[] {
  if (
    id != null &&
    Object.prototype.hasOwnProperty.call(SHIP_KIND_COLLISION_PARTS, id)
  ) {
    return SHIP_KIND_COLLISION_PARTS[id as ShipKindId]!;
  }
  return SHIP_KIND_COLLISION_PARTS[DEFAULT_SHIP_KIND]!;
}

/** One collision triangle (3 CCW vertices), entity-local math-up frame. */
export type CollisionTriangle = readonly [Vec2, Vec2, Vec2];

/**
 * Fan-triangulate one convex part from vertex 0: (v0, vi, vi+1) for i in
 * [1, n-2]. Each convex part of n vertices yields n-2 triangles. Because the
 * part is convex + CCW (guaranteed by `decomposeForKind`), every fan triangle
 * is also CCW and non-degenerate.
 */
function fanTriangulate(part: ConvexPart): CollisionTriangle[] {
  const out: CollisionTriangle[] = [];
  for (let i = 1; i + 1 < part.length; i++) {
    out.push([part[0]!, part[i]!, part[i + 1]!]);
  }
  return out;
}

/** Frozen per-kind fan-triangulation of the convex parts. Built once at module
 *  load on the frozen catalogue; key = `ShipKindId`. The TRIANGLE shape is
 *  load-bearing for collision: in Rapier 2D ONLY `triangle` colliders fire
 *  `CONTACT_FORCE_EVENTS` for static (zero-closing-velocity) overlap — `cuboid`
 *  / `convexHull` do not (proven in `hullCollisionNoTouch.test.ts`'s bare-Rapier
 *  diagnostic). The ram-damage telemetry + the `t-ship-no-self-collision` E2E
 *  positive control both depend on those events. See `World.setHullExposed`. */
export const SHIP_KIND_COLLISION_TRIANGLES: Readonly<
  Record<ShipKindId, readonly CollisionTriangle[]>
> = Object.freeze(
  Object.fromEntries(
    (Object.keys(SHIP_KIND_COLLISION_PARTS) as ShipKindId[]).map((id) => [
      id,
      Object.freeze(SHIP_KIND_COLLISION_PARTS[id]!.flatMap(fanTriangulate)),
    ]),
  ) as Record<ShipKindId, readonly CollisionTriangle[]>,
);

/**
 * Fan-triangulated collision triangles for a (possibly unknown) kind id. Same
 * forgiving fallback as `shipCollisionParts`. Consumed by
 * `World.setHullExposed` to build `RAPIER.ColliderDesc.triangle` colliders.
 */
export function shipCollisionTriangles(
  id: string | null | undefined,
): readonly CollisionTriangle[] {
  if (
    id != null &&
    Object.prototype.hasOwnProperty.call(SHIP_KIND_COLLISION_TRIANGLES, id)
  ) {
    return SHIP_KIND_COLLISION_TRIANGLES[id as ShipKindId]!;
  }
  return SHIP_KIND_COLLISION_TRIANGLES[DEFAULT_SHIP_KIND]!;
}
