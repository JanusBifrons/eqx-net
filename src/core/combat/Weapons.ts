import type { PhysicsWorld } from '../physics/World.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import { getWeapon } from './WeaponCatalogue.js';
import type { HitscanWeaponDef, ProjectileWeaponDef, WeaponDef } from './WeaponCatalogue.js';

const _hitscan = getWeapon('hitscan') as HitscanWeaponDef;
const _laser = getWeapon('laser') as ProjectileWeaponDef;

/**
 * Half a beam's hit width (`HitscanWeaponDef.hitWidth`; owner 2026-11-15,
 * "Hit by its width"): a wide beam's hit test sweeps a disc of this radius
 * down the ray (a capsule), so anything its drawn width covers is hit and it
 * stops at the first contact of its edge. 0 for a thin beam or any non-beam.
 * The one read of the field, on the server sinks and the client prediction
 * alike (#15). Pure.
 */
export function beamHalfWidth(def: WeaponDef): number {
  return def.mode === 'hitscan' && def.hitWidth !== undefined ? def.hitWidth / 2 : 0;
}

export const HITSCAN_DAMAGE = _hitscan.damage;
export const PROJECTILE_DAMAGE = _laser.damage;
export const HITSCAN_RANGE = _hitscan.range;
export const PROJECTILE_SPEED = _laser.speed;
export const WEAPON_COOLDOWN_TICKS = _hitscan.cooldownTicks;
export const PROJECTILE_RADIUS = _laser.radius;
/** Approximate ship broad-phase collision radius for scalar hit tests
 *  (missile sweep, projectile sweep, lingering-hull ray, mining-beam ray).
 *  Campaign 5.3: the SINGLE source — the former bare `12`s in
 *  MissileSimulation / SectorRoom silently drifted from this the moment
 *  either side was tuned (invariant #15). Per-kind radii at these sites are
 *  a future refinement; every site at least agrees on ONE number now. */
export const SHIP_COLLISION_RADIUS = 12;
/** Muzzle clearance (u): the fire ray starts this far ahead of the mount so
 *  a shot never self-hits — AND the client's visible barrel is exactly this
 *  long (`MountVisualManager` BARREL_LENGTH), so beams emerge from the drawn
 *  barrel tip. TWO-SIDED CONTRACT (invariant #15): the server ray offset and
 *  the client barrel/beam origin must move together — that is why both now
 *  import THIS constant instead of carrying their own `20`s. */
export const MUZZLE_CLEARANCE = 20;
/** Initial and max hull HP. Bumped during sub-phase B testing — 25 hitscan
 *  hits to die was too brittle for "fly around and watch a remote laser
 *  flash without dying every 5 s". Tune at balance pass. */
export const SHIP_MAX_HEALTH = 500;

/**
 * Instant hitscan weapon. Returns the first entity hit along the ray
 * within HITSCAN_RANGE, excluding the shooter.
 */
export function hitscanRaycast(
  world: PhysicsWorld,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  excludeId: string,
): { hitId: string; dist: number } | null {
  return world.hitscan(fromX, fromY, dirX, dirY, maxDist, excludeId);
}

/**
 * Spawn a physical projectile body in the prediction world.
 * The body is a sensor — it overlaps without generating impulses.
 */
export function spawnProjectile(
  world: PhysicsWorld,
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  radius: number,
): void {
  world.spawnProjectile(id, x, y, vx, vy, radius);
}

/**
 * Geometric ray-sphere intersection used by the server lag-comp handler.
 * Does NOT require a Rapier world — works directly from rewound positions.
 * Returns the distance along the ray to the entry point, or null on miss.
 */
export function rayHitsSphere(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number,
  radius: number,
): number | null {
  const dx = cx - fromX;
  const dy = cy - fromY;
  const t = dx * dirX + dy * dirY;
  if (t < 0) return null;
  const closestX = fromX + t * dirX;
  const closestY = fromY + t * dirY;
  const dist2 = (closestX - cx) ** 2 + (closestY - cy) ** 2;
  if (dist2 > radius * radius) return null;
  const entry = t - Math.sqrt(radius * radius - dist2);
  if (entry > maxDist) return null;
  return entry;
}

/**
 * Does the segment (fx, fy) → (fx + sx, fy + sy) come within `r` of
 * (cx, cy)? True when it starts inside the circle too. Pure, allocation-free.
 *
 * Use THIS, never `rayHitsSphere`, as the cheap bounding-circle gate in front
 * of a polygon / compound refinement: `rayHitsSphere` returns null once the
 * origin is inside the circle and past its closest approach to the centre, so
 * a shell stepping through a long capital (or a beam fired from beside one)
 * passed straight through the FAR half of the hull (2026-11-13). The same
 * helper is added to `destruction/wreckHits.ts` by PR #542; dedupe onto this
 * one when both have landed.
 */
export function segmentNearCircle(
  fx: number, fy: number, sx: number, sy: number, cx: number, cy: number, r: number,
): boolean {
  const l2 = sx * sx + sy * sy;
  let t = l2 > 0 ? ((cx - fx) * sx + (cy - fy) * sy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = fx + sx * t - cx;
  const py = fy + sy * t - cy;
  return px * px + py * py <= r * r;
}

/**
 * Ray vs an axis-aligned box centred on (cx, cy) with half extents (hw, hh) —
 * structure footprints (phase V; rotations are quarter turns, so a structure
 * is an axis-aligned box in world space). Slab clip. Returns the distance to
 * the entry point (0 when the ray starts inside), or null on a miss.
 * Allocation-free.
 */
export function rayHitsBox(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number,
  hw: number, hh: number,
  boxes?: Float32Array,
  /** A wide beam's half-width (`beamHalfWidth`): the box is hit on its
   *  outline rounded by it (exact, round corners). 0 ⇒ the thin ray. */
  halfWidth = 0,
): number | null {
  if (boxes) return rayHitsBoxParts(fromX, fromY, dirX, dirY, maxDist, cx, cy, boxes, 0, halfWidth);
  return halfWidth > 0
    ? capsuleHitsAabb(fromX, fromY, dirX, dirY, maxDist, cx, cy, hw, hh, halfWidth)
    : rayHitsAabb(fromX, fromY, dirX, dirY, maxDist, cx, cy, hw, hh);
}

/**
 * A ray against a structure made of several boxes (a gate's posts and walls):
 * `boxes` is flat `[offsetX, offsetY, halfW, halfH, ...]` from the centre,
 * each padded by `pad`. The nearest hit wins; the gap between parts is open.
 * Alloc-free.
 */
export function rayHitsBoxParts(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number,
  boxes: Float32Array,
  pad: number,
  /** A wide beam's half-width (see `rayHitsBox`); 0 ⇒ the thin ray. */
  halfWidth = 0,
): number | null {
  let best: number | null = null;
  for (let i = 0; i + 3 < boxes.length; i += 4) {
    const bx = cx + boxes[i]!, by = cy + boxes[i + 1]!, bw = boxes[i + 2]! + pad, bh = boxes[i + 3]! + pad;
    const t = halfWidth > 0
      ? capsuleHitsAabb(fromX, fromY, dirX, dirY, maxDist, bx, by, bw, bh, halfWidth)
      : rayHitsAabb(fromX, fromY, dirX, dirY, maxDist, bx, by, bw, bh);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

function rayHitsAabb(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number,
  hw: number, hh: number,
): number | null {
  let tMin = 0;
  let tMax = maxDist;
  const minX = cx - hw, maxX = cx + hw, minY = cy - hh, maxY = cy + hh;
  if (Math.abs(dirX) < 1e-12) {
    if (fromX < minX || fromX > maxX) return null;
  } else {
    let t1 = (minX - fromX) / dirX;
    let t2 = (maxX - fromX) / dirX;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (Math.abs(dirY) < 1e-12) {
    if (fromY < minY || fromY > maxY) return null;
  } else {
    let t1 = (minY - fromY) / dirY;
    let t2 = (maxY - fromY) / dirY;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

/**
 * First contact of a disc of radius `r` swept from (fx, fy) along the unit
 * ray against the circle (cx, cy, 0): the ray against a circle of radius `r`.
 * 0 when it starts inside; null when it moves away or passes. Alloc-free.
 */
function discEntry(
  fx: number, fy: number, dx: number, dy: number, maxDist: number, cx: number, cy: number, r: number,
): number | null {
  const ox = fx - cx;
  const oy = fy - cy;
  const c = ox * ox + oy * oy - r * r;
  if (c <= 0) return 0;
  const b = ox * dx + oy * dy;
  if (b >= 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t <= maxDist ? t : null;
}

/**
 * A wide beam (a disc of radius `r` swept down the ray: a capsule) vs an
 * axis-aligned box: the ray against the box's outline rounded by `r`, which
 * is the union of the box grown by `r` in x, the box grown by `r` in y and
 * a disc at each corner, so the first contact is the nearest entry of the
 * six. Exact (round corners, like a Rapier ball cast). Alloc-free.
 */
function capsuleHitsAabb(
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, hw: number, hh: number, r: number,
): number | null {
  let best = rayHitsAabb(fx, fy, dx, dy, maxDist, cx, cy, hw + r, hh);
  const t = rayHitsAabb(fx, fy, dx, dy, maxDist, cx, cy, hw, hh + r);
  if (t !== null && (best === null || t < best)) best = t;
  for (let k = 0; k < 4; k++) {
    const d = discEntry(fx, fy, dx, dy, maxDist, cx + (k & 1 ? hw : -hw), cy + (k & 2 ? hh : -hh), r);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * A wide beam vs a CCW convex polygon, in the polygon's local frame: the
 * first `t` at which the disc of radius `r` centred on (lx, ly) + t·(ldx,
 * ldy) touches the polygon (its outline rounded by `r`, whose boundary is the
 * edges pushed out by `r` and a disc at each vertex). 0 when it starts in
 * reach. Alloc-free.
 */
function capsuleHitsConvexLocal(
  lx: number, ly: number, ldx: number, ldy: number, maxDist: number, r: number,
  vertices: ReadonlyArray<Vec2>,
): number | null {
  const n = vertices.length;
  // Starts within r of the polygon (or inside it) ⇒ contact at once.
  let inside = true;
  let near2 = Infinity;
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1 < n ? i + 1 : 0]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const wx = lx - a.x;
    const wy = ly - a.y;
    if (wx * ey - wy * ex > 0) inside = false;
    const l2 = ex * ex + ey * ey;
    let s = l2 > 0 ? (wx * ex + wy * ey) / l2 : 0;
    if (s < 0) s = 0;
    else if (s > 1) s = 1;
    const qx = wx - ex * s;
    const qy = wy - ey * s;
    const d2 = qx * qx + qy * qy;
    if (d2 < near2) near2 = d2;
  }
  if (inside || near2 <= r * r) return 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1 < n ? i + 1 : 0]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len > 0) {
      // Outward unit normal of a CCW edge: (ey, −ex) / len.
      const nx = ey / len;
      const ny = -ex / len;
      const denom = ldx * nx + ldy * ny;
      if (denom < 0) {
        // Crossing the edge line pushed out by r, within the edge's span.
        const t = (r - ((lx - a.x) * nx + (ly - a.y) * ny)) / denom;
        if (t >= 0 && t < best) {
          const s = ((lx + ldx * t - a.x) * ex + (ly + ldy * t - a.y) * ey) / (len * len);
          if (s >= 0 && s <= 1) best = t;
        }
      }
    }
    const d = discEntry(lx, ly, ldx, ldy, maxDist, a.x, a.y, r);
    if (d !== null && d < best) best = d;
  }
  return best <= maxDist ? best : null;
}

/** Swept projectile (radius `projRadius`) vs a structure box: the box grown
 *  by the projectile radius, then a ray along the step. Same return shape as
 *  `projectileSweepCircle`. */
export function projectileSweepBox(
  fromX: number, fromY: number,
  stepX: number, stepY: number,
  projRadius: number,
  cx: number, cy: number,
  hw: number, hh: number,
  boxes?: Float32Array,
): { entry: number; hitX: number; hitY: number } | null {
  const segLen = Math.hypot(stepX, stepY);
  if (segLen < 1e-6) return null;
  const dirX = stepX / segLen;
  const dirY = stepY / segLen;
  const entry = boxes
    ? rayHitsBoxParts(fromX, fromY, dirX, dirY, segLen, cx, cy, boxes, projRadius)
    : rayHitsAabb(fromX, fromY, dirX, dirY, segLen, cx, cy, hw + projRadius, hh + projRadius);
  if (entry === null) return null;
  return { entry, hitX: fromX + dirX * entry, hitY: fromY + dirY * entry };
}

/**
 * Swept circle-vs-circle collision for a one-tick projectile step.
 *
 * Tests the segment from `(fromX, fromY)` to `(fromX + stepX, fromY + stepY)`
 * against a target circle at `(cx, cy)` with the given `targetRadius`. Uses
 * the Minkowski trick — a 0-thickness ray against a circle expanded by
 * `projRadius + targetRadius` is mathematically identical to a swept
 * `projRadius` circle vs a stationary `targetRadius` circle.
 *
 * Returns the parametric entry distance along the step plus the precise hit
 * point, or `null` on miss / zero-length step. Negative entries (origin
 * already inside the expanded circle, e.g. spawned grazing a target) are
 * clamped to 0 so the hit point is reported at the segment origin.
 */
export function projectileSweepCircle(
  fromX: number, fromY: number,
  stepX: number, stepY: number,
  projRadius: number,
  cx: number, cy: number,
  targetRadius: number,
): { entry: number; hitX: number; hitY: number } | null {
  const segLen = Math.hypot(stepX, stepY);
  if (segLen < 1e-6) return null;
  const dirX = stepX / segLen;
  const dirY = stepY / segLen;
  const entry = rayHitsSphere(fromX, fromY, dirX, dirY, segLen, cx, cy, projRadius + targetRadius);
  if (entry === null) return null;
  const t = entry > 0 ? entry : 0;
  return { entry: t, hitX: fromX + dirX * t, hitY: fromY + dirY * t };
}

/**
 * Geometric ray-convex-polygon intersection. Pure: takes vertices in
 * entity-local space (CCW) plus the entity's world-space `(cx, cy, angle)`,
 * transforms the ray into local space, then runs the standard convex
 * slab-clip algorithm. Returns the distance along the world-space ray to the
 * entry point, or null on miss.
 *
 * Vertices must be a closed convex polygon with at least 3 points. The CCW
 * orientation is assumed (matches `convexHullCCW` output and the asteroid
 * shape generator).
 */
export function rayHitsConvexPolygon(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number, angle: number,
  vertices: ReadonlyArray<Vec2>,
  /** A wide beam's half-width (`beamHalfWidth`): first contact of a disc of
   *  this radius swept down the ray (a capsule). 0 ⇒ the thin ray. */
  halfWidth = 0,
): number | null {
  const n = vertices.length;
  if (n < 3) return null;

  // Transform ray into entity-local space: subtract centre, then rotate by
  // -angle so the polygon is in its canonical orientation.
  const cosA = Math.cos(-angle);
  const sinA = Math.sin(-angle);
  const localX = (fromX - cx) * cosA - (fromY - cy) * sinA;
  const localY = (fromX - cx) * sinA + (fromY - cy) * cosA;
  const localDx = dirX * cosA - dirY * sinA;
  const localDy = dirX * sinA + dirY * cosA;
  if (halfWidth > 0) return capsuleHitsConvexLocal(localX, localY, localDx, localDy, maxDist, halfWidth, vertices);

  // Slab clip: track entering/exiting t along the ray as we test each edge.
  let tEnter = 0;
  let tExit = maxDist;

  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    // Outward normal for CCW polygon: (edge.y, -edge.x).
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const nx = ey;
    const ny = -ex;
    const denom = localDx * nx + localDy * ny;
    const numer = (localX - a.x) * nx + (localY - a.y) * ny;
    if (denom === 0) {
      // Ray parallel to this edge: outside the half-space → no hit.
      if (numer > 0) return null;
      continue;
    }
    const t = -numer / denom;
    if (denom < 0) {
      // Entering this half-space.
      if (t > tEnter) tEnter = t;
    } else {
      // Exiting this half-space.
      if (t < tExit) tExit = t;
    }
    if (tEnter > tExit) return null;
  }

  if (tEnter > maxDist) return null;
  return tEnter;
}

/**
 * Nearest ray-vs-ship-polygon entry: min over the precomputed hull
 * triangles of `rayHitsConvexPolygon`. Each triangle is a CCW convex
 * polygon (>=3 verts) so the existing slab-clip applies unchanged. Used
 * by the server hitscan path ONLY when the target shield is down — the
 * cheap bounding-circle reject runs first (see SectorRoom).
 */
export function rayHitsShipPolygon(
  fromX: number, fromY: number,
  dirX: number, dirY: number,
  maxDist: number,
  cx: number, cy: number, angle: number,
  triangles: ReadonlyArray<ReadonlyArray<Vec2>>,
  /** A wide beam's half-width (see `rayHitsConvexPolygon`); 0 ⇒ thin. */
  halfWidth = 0,
): number | null {
  let best: number | null = null;
  for (const tri of triangles) {
    const d = rayHitsConvexPolygon(fromX, fromY, dirX, dirY, maxDist, cx, cy, angle, tri, halfWidth);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * Swept one-tick projectile step vs the ship hull polygon. Mirrors
 * `projectileSweepCircle`\u2019s return shape (entry distance + hit point,
 * negative entry clamped to 0) so the caller\u2019s best-entry logic is
 * unchanged. The projectile RADIUS is intentionally ignored (the cheap
 * circle broadphase already used projRadius+shipRadius; refining to the
 * tighter bare-hull polygon is the intended shield-down behaviour — the
 * rim band between hull and circle is a deliberate miss).
 */
export function sweptSegmentHitsShipPolygon(
  fromX: number, fromY: number,
  stepX: number, stepY: number,
  cx: number, cy: number, angle: number,
  triangles: ReadonlyArray<ReadonlyArray<Vec2>>,
): { entry: number; hitX: number; hitY: number } | null {
  const segLen = Math.hypot(stepX, stepY);
  if (segLen < 1e-6) return null;
  const dirX = stepX / segLen;
  const dirY = stepY / segLen;
  const d = rayHitsShipPolygon(fromX, fromY, dirX, dirY, segLen, cx, cy, angle, triangles);
  if (d === null) return null;
  const t = d > 0 ? d : 0;
  return { entry: t, hitX: fromX + dirX * t, hitY: fromY + dirY * t };
}

/**
 * Distance from the world point (px, py) to the nearest point of a ship hull
 * made of CCW convex parts (`shipCollisionParts`, the same parts
 * `rayHitsShipPolygon` tests) at pose (cx, cy, angle); 0 inside the hull. The
 * hull is the union of the parts, so the distance is the minimum over them.
 * Same local frame as `rayHitsConvexPolygon`. Allocation-free.
 */
export function pointToShipPolygonDistance(
  px: number, py: number,
  cx: number, cy: number, angle: number,
  parts: ReadonlyArray<ReadonlyArray<Vec2>>,
): number {
  const cosA = Math.cos(-angle);
  const sinA = Math.sin(-angle);
  const lx = (px - cx) * cosA - (py - cy) * sinA;
  const ly = (px - cx) * sinA + (py - cy) * cosA;
  let best2 = Infinity;
  for (let p = 0; p < parts.length; p++) {
    const poly = parts[p]!;
    const n = poly.length;
    if (n < 3) continue;
    let inside = true;
    let part2 = Infinity;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[i + 1 < n ? i + 1 : 0]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const wx = lx - a.x;
      const wy = ly - a.y;
      // Outward normal of a CCW edge is (ey, -ex): positive ⇒ outside it.
      if (wx * ey - wy * ex > 0) inside = false;
      const l2 = ex * ex + ey * ey;
      let t = l2 > 0 ? (wx * ex + wy * ey) / l2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const dx = wx - ex * t;
      const dy = wy - ey * t;
      const d2 = dx * dx + dy * dy;
      if (d2 < part2) part2 = d2;
    }
    if (inside) return 0;
    if (part2 < best2) best2 = part2;
  }
  return Math.sqrt(best2); // no parts ⇒ Infinity (never "in reach")
}
