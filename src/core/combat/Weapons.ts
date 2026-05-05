import type { PhysicsWorld } from '../physics/World.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

export const HITSCAN_DAMAGE = 20;
export const PROJECTILE_DAMAGE = 15;
export const HITSCAN_RANGE = 500;
export const PROJECTILE_SPEED = 300;
export const WEAPON_COOLDOWN_TICKS = 10;
export const PROJECTILE_RADIUS = 4;
export const SHIP_COLLISION_RADIUS = 12;
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
