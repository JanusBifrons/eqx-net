/**
 * Pure deterministic asteroid silhouette generator.
 *
 * The same `(entityId, targetRadius)` pair always produces the same vertex
 * array everywhere — server worker, server hit-test, client prediction, client
 * renderer. That determinism is what lets us reuse the wire's existing dense
 * `entityId` as a free shape seed: zero added bytes per snapshot.
 *
 * Vertices are emitted in CCW order around the origin with monotonic angles,
 * so the output is convex by construction. The Rapier `convexHull` collider
 * builder accepts the result without further work; the `polygonArea` helper
 * lets `World.spawnObstacle` set density for an exact target mass.
 */

import {
  ASTEROID_VERTEX_COUNT_MIN,
  ASTEROID_VERTEX_COUNT_MAX,
  ASTEROID_VERTEX_RADIAL_MIN,
  ASTEROID_VERTEX_RADIAL_MAX,
  ASTEROID_VERTEX_ANGULAR_JITTER,
} from './asteroidConstants.js';

export interface Vec2 {
  x: number;
  y: number;
}

/** 32-bit deterministic PRNG. Spec-defined operations only — bit-identical
 *  on Node and Chromium. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a deterministic convex polygon for an asteroid.
 *
 * Vertices are sampled in polar coordinates (monotonic angles, varying radii)
 * and then passed through a convex-hull post-pass — deeply-radially-recessed
 * samples that would create concavities are dropped from the hull, leaving a
 * convex polygon with possibly fewer vertices than the initial sample count.
 * The visual output is still asteroid-shaped: flat edges where concavities
 * used to be, asymmetric silhouette overall.
 *
 * @param entityId - dense u16 already on the wire; reused as the shape seed
 * @param targetRadius - bounding radius the polygon fits within
 */
export function generateAsteroidVertices(entityId: number, targetRadius: number): Vec2[] {
  // Golden-ratio hash breaks low-bit correlation between adjacent entityIds —
  // sequential seeds otherwise feed mulberry32 with patterns that produce
  // visually similar shapes for entities that spawn together.
  const seed = (Math.imul(entityId, 0x9e3779b1)) >>> 0;
  const prng = mulberry32(seed);

  const countSpan = ASTEROID_VERTEX_COUNT_MAX - ASTEROID_VERTEX_COUNT_MIN + 1;
  const count = ASTEROID_VERTEX_COUNT_MIN + Math.floor(prng() * countSpan);

  const angleStep = (Math.PI * 2) / count;
  const angleJitter = angleStep * ASTEROID_VERTEX_ANGULAR_JITTER;
  const radialSpan = ASTEROID_VERTEX_RADIAL_MAX - ASTEROID_VERTEX_RADIAL_MIN;

  const samples: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const baseAngle = i * angleStep;
    const angle = baseAngle + (prng() - 0.5) * 2 * angleJitter;
    const r = targetRadius * (ASTEROID_VERTEX_RADIAL_MIN + prng() * radialSpan);
    samples[i] = { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  }
  return convexHullCCW(samples);
}

/**
 * Andrew's monotone chain — O(n log n) convex hull. Output is in CCW order
 * with no collinear-on-edge points. Deterministic: identical input order
 * produces identical output everywhere.
 */
export function convexHullCCW(points: ReadonlyArray<Vec2>): Vec2[] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const n = sorted.length;

  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = sorted[i]!;
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Vec2[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Flatten a vertex list into the `[x0,y0,x1,y1,...]` Float32Array Rapier expects. */
export function verticesToFloat32(verts: ReadonlyArray<Vec2>): Float32Array {
  const out = new Float32Array(verts.length * 2);
  for (let i = 0; i < verts.length; i++) {
    out[i * 2] = verts[i]!.x;
    out[i * 2 + 1] = verts[i]!.y;
  }
  return out;
}

/** Signed area of the polygon (shoelace). Always positive for CCW input. */
export function polygonArea(verts: ReadonlyArray<Vec2>): number {
  if (verts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}
