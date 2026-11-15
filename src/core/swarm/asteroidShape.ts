/**
 * Pure deterministic asteroid silhouette generator.
 *
 * The same `(shapeSeed, targetRadius)` pair always produces the same vertex
 * array everywhere — server worker, server hit-test, client prediction, client
 * renderer. The u16 shape seed comes from the rock's stable id
 * (`asteroidShapeSeed`) and rides the swarm wire in a u16 that kind 0 did not
 * use, so a rock keeps its shape however its wire id changes.
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
import { ANGLE_STEPS, unitDirFromSteps } from '../geometry/unitDir.js';
import { fnv1a32 } from '../random/rng.js';

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

/** Bump on any change to the outline an `(shapeSeed, radius)` pair gives.
 *  v2 (macro terrain 1a): seeded by the rock's stable id, arithmetic only. */
export const ASTEROID_SHAPE_VERSION = 2;

/**
 * A rock's shape seed: a u16 hash of its STABLE id (the registry `rec.id`,
 * e.g. `belt-0-3`), never its wire `entityId`. Wire ids are reused, so a rock
 * that leaves the world and comes back (deep sleep, macro-terrain.md) would
 * otherwise come back a different shape. The seed rides the swarm wire in
 * the u16 at `SWARM_REC_SHAPE_SEED_OFF` for kind 0, so both sides draw and
 * collide with the same outline.
 */
export function asteroidShapeSeed(stableId: string): number {
  return fnv1a32(stableId) & 0xffff;
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
 * Arithmetic only (`unitDirFromSteps`, never sin/cos), so the server and
 * every browser engine produce bit-identical vertices.
 *
 * @param shapeSeed - the rock's u16 shape seed (`asteroidShapeSeed`)
 * @param targetRadius - bounding radius the polygon fits within
 */
export function generateAsteroidVertices(shapeSeed: number, targetRadius: number): Vec2[] {
  // Golden-ratio hash breaks low-bit correlation between nearby seeds —
  // sequential seeds otherwise feed mulberry32 with patterns that produce
  // visually similar shapes.
  const seed = (Math.imul(shapeSeed, 0x9e3779b1)) >>> 0;
  const prng = mulberry32(seed);

  const countSpan = ASTEROID_VERTEX_COUNT_MAX - ASTEROID_VERTEX_COUNT_MIN + 1;
  const count = ASTEROID_VERTEX_COUNT_MIN + Math.floor(prng() * countSpan);

  // Angles in u16 steps (`ANGLE_STEPS` per turn).
  const angleStep = ANGLE_STEPS / count;
  const angleJitter = angleStep * ASTEROID_VERTEX_ANGULAR_JITTER;
  const radialSpan = ASTEROID_VERTEX_RADIAL_MAX - ASTEROID_VERTEX_RADIAL_MIN;

  const samples: Vec2[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const angle = i * angleStep + (prng() - 0.5) * 2 * angleJitter;
    const r = targetRadius * (ASTEROID_VERTEX_RADIAL_MIN + prng() * radialSpan);
    const d = unitDirFromSteps(angle);
    samples[i] = { x: d.x * r, y: d.y * r };
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

/** Mineable resource units per unit of asteroid silhouette AREA (WS-4 / R2.27 —
 *  the asteroid-interaction-model ADR's finite `resources` pool). A bigger rock
 *  holds proportionally more ore. Tuned so a typical mid-size rock lasts a
 *  couple of minutes under one Miner at miningRate~1000/pulse (~1 Hz) — a
 *  smoke-tune knob, not load-bearing for the regression locks. */
export const ASTEROID_RESOURCES_PER_AREA = 40;

/** Finite mineable resource pool for an asteroid, derived deterministically
 *  from its polygon silhouette area. Pure; whole units. */
export function asteroidResources(verts: ReadonlyArray<Vec2>): number {
  return Math.round(polygonArea(verts) * ASTEROID_RESOURCES_PER_AREA);
}
