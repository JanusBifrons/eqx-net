/**
 * Capital-vs-capital hull overlap resolver (owner decision 2026-11-12,
 * verbatim: "They absolutely should collide by design.").
 *
 * Rapier alone does not keep two capital hulls apart once they interpenetrate:
 *  1. Its contact between two multi-thousand-unit convex hulls VANISHES at
 *     depth (the narrow phase reports no contact points from the second step
 *     on; a 100× smaller copy of the same hull resolves fine, so it is a
 *     precision limit, not the shape), so nothing pushes and thrust drives the
 *     hulls deeper.
 *  2. Where a contact survives, Rapier's position correction is capped at
 *     `normalized max corrective velocity × lengthUnit` ≈ 10 u/s per contact
 *     and the bodies fall asleep partway: a 350 u overlap took most of a minute.
 * Raising `lengthUnit` lifts (2) but not (1), and is GLOBAL (it raises every
 * body's sleep threshold to ~40 u/s, which would freeze slow fighters and
 * drifting asteroids), so the fix is this capital-only pass instead.
 *
 * After every fixed step `PhysicsWorld.tick` calls `resolve()`: for each pair
 * of capital bodies whose real hulls (`shipCollisionParts`, the convex parts
 * the hitscan and the tests use) overlap by more than a skin, it
 *  - moves them apart along the minimum-translation axis by a bounded step
 *    (`CAPITAL_OVERLAP_RATE` of the depth, at most `overlapMaxStep` per tick
 *    from `shipTuning`, #18), split by inverse mass, and
 *  - removes their CLOSING velocity along that axis (a perfectly inelastic,
 *    momentum-conserving normal impulse), so thrust can't hold a hull in.
 * Only bodies spawned as capitals are ever registered, so a fighter, an
 * asteroid or a structure is never read or written here: their physics is
 * byte-identical (lock: World.capitalContact.test.ts). `PhysicsWorld` is the
 * same class on the server worker and the client predWorld, so both sides run
 * this identically (#15).
 *
 * Alloc-free per tick (#14) except Rapier's own wasm-boundary getters
 * (`translation()`, `linvel()`), which every World path already pays.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import type { ShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';

/** Fraction of the (skin-less) depth corrected per fixed step: a deep overlap
 *  slides apart at `overlapMaxStep` per tick, the last few tens of units ease
 *  out over ~0.5 s. */
const CAPITAL_OVERLAP_RATE = 0.1;

/** A capital's hull in body-local space, flattened for the per-tick SAT. */
export interface CapitalHull {
  /** Per convex part: x0, y0, x1, y1, … (body-local). */
  readonly parts: readonly Float64Array[];
  /** Farthest hull vertex from the body origin (broad-phase circle). */
  readonly reach: number;
  /** Overlap below this is contact skin, left to Rapier (u). */
  readonly skin: number;
  /** Most the pair moves apart per fixed step (u). */
  readonly maxStep: number;
}

const HULLS = new WeakMap<object, CapitalHull>();

/** The capital hull record for a kind (cached; built at spawn, never per tick). */
function capitalHull(kind: ShipKind): CapitalHull {
  const hit = HULLS.get(kind);
  if (hit) return hit;
  const t = shipTuning(kind);
  const parts: Float64Array[] = [];
  let reach = 0;
  for (const p of shipCollisionParts(kind.id)) {
    const a = new Float64Array(p.length * 2);
    for (let i = 0; i < p.length; i++) {
      a[2 * i] = p[i]!.x;
      a[2 * i + 1] = p[i]!.y;
      reach = Math.max(reach, Math.hypot(p[i]!.x, p[i]!.y));
    }
    parts.push(a);
  }
  const hull: CapitalHull = { parts, reach, skin: t.overlapSkin, maxStep: t.overlapMaxStep };
  HULLS.set(kind, hull);
  return hull;
}

/** One registered capital body. `blocked()` is true while the body is out of
 *  the world (a warp run: its colliders are off). */
export interface CapitalEntry {
  readonly body: RAPIER.RigidBody;
  readonly hull: CapitalHull;
  /** World-space part vertices, rewritten each tick (same layout as `hull.parts`). */
  readonly world: Float64Array[];
  blocked(): boolean;
}

export function newCapitalEntry(body: RAPIER.RigidBody, kind: ShipKind, blocked: () => boolean): CapitalEntry {
  const hull = capitalHull(kind);
  const world: Float64Array[] = [];
  for (const p of hull.parts) world.push(new Float64Array(p.length));
  return { body, hull, world, blocked };
}

/** Result scratch of `deepestOverlap`. */
interface Mtv { depth: number; nx: number; ny: number }

export class CapitalOverlapResolver {
  private readonly entries: CapitalEntry[] = [];
  private readonly _mtv: Mtv = { depth: 0, nx: 0, ny: 0 };
  private readonly _axis: Mtv = { depth: 0, nx: 0, ny: 0 };
  private readonly _vec = { x: 0, y: 0 };

  add(entry: CapitalEntry): void {
    this.entries.push(entry);
  }

  remove(body: RAPIER.RigidBody): void {
    const i = this.entries.findIndex((e) => e.body === body);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /** One pass over every capital pair. Call once after each fixed step. */
  resolve(): void {
    const n = this.entries.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) this.toWorld(this.entries[i]!);
    for (let i = 0; i < n; i++) {
      const a = this.entries[i]!;
      if (a.blocked()) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.entries[j]!;
        if (b.blocked()) continue;
        this.resolvePair(a, b);
      }
    }
  }

  private toWorld(e: CapitalEntry): void {
    const t = e.body.translation();
    const ang = e.body.rotation();
    const c = Math.cos(ang), s = Math.sin(ang);
    const parts = e.hull.parts;
    for (let k = 0; k < parts.length; k++) {
      const src = parts[k]!, dst = e.world[k]!;
      for (let i = 0; i < src.length; i += 2) {
        const x = src[i]!, y = src[i + 1]!;
        dst[i] = t.x + x * c - y * s;
        dst[i + 1] = t.y + x * s + y * c;
      }
    }
  }

  private resolvePair(a: CapitalEntry, b: CapitalEntry): void {
    const ta = a.body.translation(), tb = b.body.translation();
    const dx = tb.x - ta.x, dy = tb.y - ta.y;
    const r = a.hull.reach + b.hull.reach;
    if (dx * dx + dy * dy >= r * r) return;
    const mtv = this._mtv;
    if (!this.deepestOverlap(a.world, b.world, mtv)) return;
    const skin = Math.max(a.hull.skin, b.hull.skin);
    if (mtv.depth <= skin) return;
    const invA = a.body.isDynamic() ? a.body.invMass() : 0;
    const invB = b.body.isDynamic() ? b.body.invMass() : 0;
    const invSum = invA + invB;
    if (invSum <= 0) return;
    const nx = mtv.nx, ny = mtv.ny; // from a towards b
    // 1. Positional push-out, bounded per tick.
    const step = Math.min((mtv.depth - skin) * CAPITAL_OVERLAP_RATE, Math.max(a.hull.maxStep, b.hull.maxStep));
    const v = this._vec;
    if (invA > 0) {
      const k = (step * invA) / invSum;
      v.x = ta.x - nx * k; v.y = ta.y - ny * k;
      a.body.setTranslation(v, true);
    }
    if (invB > 0) {
      const k = (step * invB) / invSum;
      v.x = tb.x + nx * k; v.y = tb.y + ny * k;
      b.body.setTranslation(v, true);
    }
    // 2. Cancel the closing speed along the axis (inelastic, momentum kept).
    const va = a.body.linvel(), vb = b.body.linvel();
    const closing = (vb.x - va.x) * nx + (vb.y - va.y) * ny;
    if (closing < 0) {
      const j = -closing / invSum;
      if (invA > 0) { v.x = va.x - nx * j * invA; v.y = va.y - ny * j * invA; a.body.setLinvel(v, true); }
      if (invB > 0) { v.x = vb.x + nx * j * invB; v.y = vb.y + ny * j * invB; b.body.setLinvel(v, true); }
    }
  }

  /**
   * Deepest overlap between any part of `A` and any part of `B` (SAT on the
   * convex parts). Writes depth + unit axis pointing from the A part towards
   * the B part into `out`; false when no part pair overlaps.
   */
  private deepestOverlap(A: readonly Float64Array[], B: readonly Float64Array[], out: Mtv): boolean {
    out.depth = 0;
    let found = false;
    const ax = this._axis;
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < B.length; j++) {
        if (!satPair(A[i]!, B[j]!, ax)) continue;
        if (ax.depth > out.depth) {
          out.depth = ax.depth; out.nx = ax.nx; out.ny = ax.ny;
          found = true;
        }
      }
    }
    return found;
  }
}

/** SAT for two convex polygons (flat xy). Writes the minimum overlap and its
 *  axis (unit, oriented from `p`'s centroid towards `q`'s) into `out`. */
function satPair(p: Float64Array, q: Float64Array, out: Mtv): boolean {
  let best = Infinity, bx = 0, by = 0;
  for (let pass = 0; pass < 2; pass++) {
    const poly = pass === 0 ? p : q;
    const m = poly.length;
    for (let i = 0; i < m; i += 2) {
      const k = (i + 2) % m;
      let nx = -(poly[k + 1]! - poly[i + 1]!), ny = poly[k]! - poly[i]!;
      const len = Math.hypot(nx, ny);
      if (len === 0) continue;
      nx /= len; ny /= len;
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
      for (let v = 0; v < p.length; v += 2) { const d = p[v]! * nx + p[v + 1]! * ny; if (d < pMin) pMin = d; if (d > pMax) pMax = d; }
      for (let v = 0; v < q.length; v += 2) { const d = q[v]! * nx + q[v + 1]! * ny; if (d < qMin) qMin = d; if (d > qMax) qMax = d; }
      const o = Math.min(pMax, qMax) - Math.max(pMin, qMin);
      if (o <= 0) return false;
      if (o < best) { best = o; bx = nx; by = ny; }
    }
  }
  // Orient the axis from p towards q.
  let pcx = 0, pcy = 0, qcx = 0, qcy = 0;
  for (let v = 0; v < p.length; v += 2) { pcx += p[v]!; pcy += p[v + 1]!; }
  for (let v = 0; v < q.length; v += 2) { qcx += q[v]!; qcy += q[v + 1]!; }
  const pn = p.length / 2, qn = q.length / 2;
  if ((qcx / qn - pcx / pn) * bx + (qcy / qn - pcy / pn) * by < 0) { bx = -bx; by = -by; }
  out.depth = best; out.nx = bx; out.ny = by;
  return true;
}
