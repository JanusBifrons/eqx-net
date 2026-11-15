import RAPIER from '@dimforge/rapier2d-compat';
import { rayHitsConvexPolygon, rayHitsSphere } from '../combat/Weapons.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/**
 * Pure hitscan helper — extracted from `World.hitscan` so the
 * RAPIER.castRay-API surface lives in one place. Exclude semantics
 * match the original method: `excludeBody` is the rigid body of the
 * shooter; collider sensors are excluded; the first non-shooter
 * collider hit returns its `(hitId, dist)`.
 *
 * Returns `null` when no body is along the ray within `maxDist` OR
 * when the hit collider's parent body has no entry in `handleToId`
 * (stale despawn race — silently no-op rather than throw).
 *
 * Rapier's `castRay` API specifics — see src/core/CLAUDE.md "Rapier
 * castRay API" — the exclude param is a `RigidBody` object (not a
 * handle number); `hit.collider` is already a `Collider`; the toi
 * field is `timeOfImpact`.
 */
export function castHitscan(
  world: RAPIER.World,
  handleToId: ReadonlyMap<number, string>,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  excludeBody: RAPIER.RigidBody | undefined,
  /** Optional wall-body handle → `wall-${id}` sentinel map. Shield-wall span
   *  bodies are deliberately kept OUT of `handleToId` (they are static,
   *  slot-less, pose-broadcast-free — see World.ts) but a beam must still
   *  TERMINATE at an up wall (R2.28). When `handleToId` misses, this map
   *  resolves a wall hit to its sentinel id. A DISABLED (down) wall is excluded
   *  from `castRay` by Rapier, so it is naturally passable. */
  wallHandleToId?: ReadonlyMap<number, string>,
  /** Optional Rapier `filterPredicate`: return false to let the ray pass
   *  through that collider. Pass a long-lived function, not a fresh closure. */
  filterPredicate?: (collider: RAPIER.Collider) => boolean,
  /** A wide beam's half-width (`beamHalfWidth`): also sweep a disc of this
   *  radius (`castHitscanDisc`) and keep the nearer hit. 0 ⇒ the thin ray. */
  halfWidth = 0,
): { hitId: string; dist: number } | null {
  if (halfWidth > 0) {
    // The disc reaches every body the thin ray does, no later; the thin ray
    // adds only the shield walls the width skips.
    const thin = castHitscan(world, handleToId, fromX, fromY, dirX, dirY, maxDist, excludeBody, wallHandleToId, filterPredicate);
    const wide = castHitscanDisc(world, handleToId, fromX, fromY, dirX, dirY, maxDist, halfWidth, excludeBody, filterPredicate);
    return wide !== null && (thin === null || wide.dist < thin.dist) ? wide : thin;
  }
  const ray = new RAPIER.Ray({ x: fromX, y: fromY }, { x: dirX, y: dirY });
  const hit = world.castRay(
    ray,
    maxDist,
    true,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    undefined,
    excludeBody,
    filterPredicate,
  );
  if (!hit) return null;
  const parentBody = hit.collider.parent();
  if (!parentBody) return null;
  const hitId = handleToId.get(parentBody.handle) ?? wallHandleToId?.get(parentBody.handle);
  if (!hitId) return null;
  return { hitId, dist: hit.timeOfImpact };
}

/**
 * A wide beam's hitscan (the heavy beam hits by its width, owner 2026-11-15):
 * the first contact of a disc of radius `halfWidth` swept from (fromX, fromY)
 * down the unit ray, against the predWorld bodies. Rapier finds the
 * candidates (colliders overlapping the box the swept disc covers; an
 * overlap test, never Rapier's shape cast, which in this version misses some
 * polygon contacts outright) and each candidate's contact is computed by the
 * SAME core capsule maths the server uses (`rayHitsConvexPolygon` /
 * `rayHitsSphere` with the half-width, #15) on the collider's own shape and
 * pose. Same exclusions and id lookup as `castHitscan` (bodies not in
 * `handleToId`, e.g. shield walls, are not reached by the width: a wall
 * stops a beam where its centre line crosses, as on the server). Returns the
 * nearest contact (0 when it starts touching), or null. Alloc-free apart
 * from Rapier's own query plumbing.
 */
export function castHitscanDisc(
  world: RAPIER.World,
  handleToId: ReadonlyMap<number, string>,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  halfWidth: number,
  excludeBody: RAPIER.RigidBody | undefined,
  filterPredicate?: (collider: RAPIER.Collider) => boolean,
): { hitId: string; dist: number } | null {
  const q = DISC_Q;
  q.handleToId = handleToId;
  q.fx = fromX; q.fy = fromY; q.dx = dirX; q.dy = dirY; q.maxDist = maxDist; q.hw = halfWidth;
  q.best = Infinity; q.bestId = null;
  // The box the swept disc covers: from hw behind the muzzle to hw past max range.
  let box = DISC_BOX;
  if (box === null || box.halfExtents.x !== maxDist / 2 + halfWidth || box.halfExtents.y !== halfWidth) {
    box = DISC_BOX = new RAPIER.Cuboid(maxDist / 2 + halfWidth, halfWidth);
  }
  DISC_POS.x = fromX + dirX * (maxDist / 2);
  DISC_POS.y = fromY + dirY * (maxDist / 2);
  world.intersectionsWithShape(
    DISC_POS, Math.atan2(dirY, dirX), box, discVisit,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, excludeBody, filterPredicate,
  );
  q.handleToId = null;
  if (q.bestId === null) return null;
  return { hitId: q.bestId, dist: q.best };
}

/** The query in progress (one at a time; JS is single-threaded). */
const DISC_Q = {
  handleToId: null as ReadonlyMap<number, string> | null,
  fx: 0, fy: 0, dx: 0, dy: 0, maxDist: 0, hw: 0,
  best: Infinity, bestId: null as string | null,
};
let DISC_BOX: RAPIER.Cuboid | null = null;
const DISC_POS = { x: 0, y: 0 };

/** Scratch polygons by vertex count (made on first use, #14). */
const SCRATCH_POLYS: Vec2[][] = [];
function scratchPoly(n: number): Vec2[] {
  let p = SCRATCH_POLYS[n];
  if (p === undefined) {
    p = [];
    for (let i = 0; i < n; i++) p.push({ x: 0, y: 0 });
    SCRATCH_POLYS[n] = p;
  }
  return p;
}

/** Fill a scratch polygon from flat [x0, y0, x1, y1, ...], counter-clockwise. */
function polyFromFlat(flat: Float32Array): Vec2[] {
  const n = flat.length >> 1;
  const p = scratchPoly(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    area += flat[2 * i]! * flat[2 * j + 1]! - flat[2 * j]! * flat[2 * i + 1]!;
  }
  for (let i = 0; i < n; i++) {
    const k = area >= 0 ? i : n - 1 - i;
    p[i]!.x = flat[2 * k]!;
    p[i]!.y = flat[2 * k + 1]!;
  }
  return p;
}

const TRI_FLAT = new Float32Array(6);
const BOX_FLAT = new Float32Array(8);

/** Each candidate collider: the capsule's first contact with its shape. */
function discVisit(collider: RAPIER.Collider): boolean {
  const q = DISC_Q;
  const parent = collider.parent();
  if (!parent) return true;
  const id = q.handleToId!.get(parent.handle);
  if (id === undefined) return true;
  const shape = collider.shape;
  const t = collider.translation(); // TODO: alloc-debt (Rapier returns a fresh vector)
  const rot = collider.rotation();
  let d: number | null = null;
  let poly: Vec2[] | null = null;
  let r = q.hw;
  switch (shape.type) {
    case RAPIER.ShapeType.Ball:
      d = rayHitsSphere(q.fx, q.fy, q.dx, q.dy, q.maxDist, t.x, t.y, (shape as RAPIER.Ball).radius + q.hw);
      break;
    case RAPIER.ShapeType.Cuboid:
    case RAPIER.ShapeType.RoundCuboid: {
      const he = (shape as RAPIER.Cuboid).halfExtents;
      BOX_FLAT[0] = -he.x; BOX_FLAT[1] = -he.y; BOX_FLAT[2] = he.x; BOX_FLAT[3] = -he.y;
      BOX_FLAT[4] = he.x; BOX_FLAT[5] = he.y; BOX_FLAT[6] = -he.x; BOX_FLAT[7] = he.y;
      poly = polyFromFlat(BOX_FLAT);
      if (shape.type === RAPIER.ShapeType.RoundCuboid) r += (shape as RAPIER.RoundCuboid).borderRadius;
      break;
    }
    case RAPIER.ShapeType.Triangle:
    case RAPIER.ShapeType.RoundTriangle: {
      const tri = shape as RAPIER.Triangle;
      TRI_FLAT[0] = tri.a.x; TRI_FLAT[1] = tri.a.y; TRI_FLAT[2] = tri.b.x;
      TRI_FLAT[3] = tri.b.y; TRI_FLAT[4] = tri.c.x; TRI_FLAT[5] = tri.c.y;
      poly = polyFromFlat(TRI_FLAT);
      if (shape.type === RAPIER.ShapeType.RoundTriangle) r += (shape as RAPIER.RoundTriangle).borderRadius;
      break;
    }
    case RAPIER.ShapeType.ConvexPolygon:
    case RAPIER.ShapeType.RoundConvexPolygon:
      poly = polyFromFlat((shape as RAPIER.ConvexPolygon).vertices);
      if (shape.type === RAPIER.ShapeType.RoundConvexPolygon) r += (shape as RAPIER.RoundConvexPolygon).borderRadius;
      break;
    default:
      return true; // no weapon-hittable body uses another shape; the thin ray still covers it
  }
  if (poly !== null && poly.length >= 3) d = rayHitsConvexPolygon(q.fx, q.fy, q.dx, q.dy, q.maxDist, t.x, t.y, rot, poly, r);
  if (d !== null && d < q.best) {
    q.best = d;
    q.bestId = id;
  }
  return true;
}
