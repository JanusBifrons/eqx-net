/**
 * Capital destruction S2a: turn a dying capital into wreck-piece rigid bodies
 * (docs/architecture/capital-destruction.md §S2).
 *
 * Pure: the server calls it once per capital death, then spawns one dynamic
 * body per returned piece. It runs `fractureHull` on the kind's 1× hull
 * outline (Pixi-up, the frame the S2b descriptor will name), then places each
 * piece in the world exactly where that part of the hull was:
 *  - the outline maps to the live collider's frame like `shipShapeToPolygon`
 *    (x·s, −y·s), then rotates by the ship's angle and moves to its position;
 *  - each body sits at its piece's centroid, its convex parts recentred there
 *    (CCW in math-up, so the Y flip reverses each ring);
 *  - mass ∝ area at the ship's own density (hull mass / hull area); Rapier
 *    derives each piece's inertia from its parts at that density;
 *  - velocity is the rigid-body velocity of the hull at that point
 *    (v + ω × r) and spin is the ship's ω: the pieces hold the hull's shape
 *    for `WRECK_CRACK_MS`. Then the server adds each piece's `kick` (a slow
 *    push away from the kill point, a slow seeded spin, and the least
 *    impulses that make every pair of neighbours part along their shared
 *    cut; owner review 2026-11-13: heavy, and neighbours never overlap or
 *    hinge).
 *
 * Runs once per death (not hot-loop code); allocates freely.
 */
import { fractureHull, projectToOutline, FRACTURE_MAX_PIECES, FRACTURE_SNAP_CHANCE } from './fractureHull.js';
import { Rng, fnvMixU32 } from '../random/rng.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { massOf, shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Outward push falloff radius, as a fraction of the hull radius: a piece
 *  this far from the kill point gets half the extra push. The speeds
 *  themselves are `shipTuning(kind).wreckPushMax/Min` (#18). */
export const WRECK_PUSH_FALLOFF_FRAC = 0.3;
/** Seeded spin kick, as the speed of the piece's rim (its bounding radius)
 *  in units of `shipTuning(kind).wreckSeparate`, at the kill point and far
 *  from it; falls off with distance like the push, and each piece gets
 *  0.55–1× of it, either way round. A rim speed (not a fixed rad/s) so a big
 *  piece turns slower than a small one, like a heavy body (owner review
 *  2026-11-13: "more inertia and weight"). Scaled down when `wreckSeparate`
 *  went up 5.6× (the break must be seen), so the spin stayed as slow. */
export const WRECK_SPIN_RIM_NEAR = 0.13;
export const WRECK_SPIN_RIM_FAR = 0.05;
/** A piece smaller than this fraction of the hull radius spins like one this
 *  size, so a sliver doesn't whirl (~3°/s at most at the kill point). */
export const WRECK_SPIN_MIN_RADIUS_FRAC = 0.06;
/** Separation passes over the neighbour seams (Gauss–Seidel on "part at
 *  least `wreckSeparate`"). Each correction aims a little past the target
 *  (`SEPARATE_AIM`), so a chain of seams settles above it in a few dozen
 *  passes instead of creeping up to it; the passes stop once every seam
 *  opens at `wreckSeparate` or more. */
const SEPARATE_ITERATIONS = 400;
const SEPARATE_AIM = 1.1;
/** Least speed (in `wreckSeparate`) at which two neighbours' centres part. */
const CENTRE_PART = 0.5;
/** Wreck pieces coast, then settle into terrain. Light enough that the
 *  debris field keeps opening for seconds (review 2026-11-12: at 0.05 / 0.1
 *  with a ~10 u/s push the pieces barely moved in 6 s), heavy enough that a
 *  piece flung at ~400 u/s comes to rest within a few kilometres instead of
 *  leaving the sector (money-shot review: the push went up 3×). */
export const WRECK_LINEAR_DAMPING = 0.06;
export const WRECK_ANGULAR_DAMPING = 0.05;
/** Room-wide cap on live wreck bodies (each takes a physics slot). Owner:
 *  wrecks stay for ever; this is only a budget guard (the oldest wreck piece
 *  goes first, S2b revisits it with persistence). */
export const MAX_LIVE_WRECK_PIECES = 768;
/** The recent-damage window: damage over this many ticks (~3 s at 60 Hz). */
export const WRECK_RECENT_DAMAGE_TICKS = 180;

export interface WreckDeathPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

export interface WreckBuildInput {
  kindId: ShipKindId;
  pose: WreckDeathPose;
  /** World point the killing blow landed (projected onto the hull). */
  killWorld: Vec2 | null;
  /** Fallback when the hit had no point: the attacker's world position (the
   *  nearest hull point to it is used). Null ⇒ the hull point nearest the centre. */
  attackerWorld: Vec2 | null;
  seed: number;
  /** Final hit's damage / max hull. */
  killBlowDamage: number;
  /** Damage over the last ~3 s / max hull. */
  recentDamageRate: number;
}

export interface WreckPieceSpec {
  index: number;
  x: number;
  y: number;
  /** Spawn velocity: the dead hull's rigid motion at this point (v + ω × r). */
  vx: number;
  vy: number;
  angle: number;
  /** Spawn spin: the dead hull's ω. */
  angvel: number;
  /** Added after `WRECK_CRACK_MS`: the separating push (world frame at the
   *  death angle; rotate by how far the piece has turned since) and spin. */
  kickVx: number;
  kickVy: number;
  kickAngvel: number;
  /** Convex parts, body-local math-up, CCW, centred on (x, y). */
  parts: Vec2[][];
  /** The physics collider: `parts`, each shrunk by `wreckColliderInset`. */
  colliderParts: Vec2[][];
  /** World-unit area (scaled). */
  area: number;
  mass: number;
  /** Farthest part vertex from the centre (bounding circle). */
  radius: number;
}

/**
 * The fracture inputs of one wreck: everything `wreckPieceGeometry` needs.
 * This is exactly what the S2b `wrecks[]` snapshot descriptor carries, so a
 * client rebuilds the same pieces the server spawned (no vertex on the wire).
 */
export interface WreckFractureInputs {
  kindId: ShipKindId;
  seed: number;
  /** Kill point in the hull's 1× Pixi-up frame, already on the outline. */
  killX: number;
  killY: number;
  killBlowDamage: number;
  recentDamageRate: number;
  snapChance: number;
}

/** One piece's shape in its own body frame (math-up, centred on its
 *  centroid). Shared by the server body, the client predWorld twin and the
 *  client drawing (#15). */
export interface WreckPieceGeometry {
  index: number;
  /** Centroid in the ship's scaled math-up frame (before the ship's turn). */
  cx: number;
  cy: number;
  /** Convex parts, body-local math-up, CCW (drawing and weapon hits). */
  parts: Vec2[][];
  /** The physics collider (server body and client twin alike): each part
   *  shrunk by `shipTuning(kind).wreckColliderInset` toward its centre, so
   *  neighbours sharing a cut edge spawn a hair apart (pieces collide with
   *  each other). */
  colliderParts: Vec2[][];
  /** The piece outline, body-local math-up, CCW. */
  outline: Vec2[];
  /** `cutEdges[i]`: edge outline[i] → outline[i+1] is a new cut (S3 glow). */
  cutEdges: boolean[];
  /** World-unit area (scaled). */
  area: number;
  mass: number;
  /** Farthest part vertex from the centre (bounding circle). */
  radius: number;
}

export interface WreckBuild {
  pieces: WreckPieceSpec[];
  /** The inputs the pieces were fractured from (the S2b descriptor). */
  fracture: WreckFractureInputs;
  /** The kill point in the hull's 1× Pixi-up frame, on the outline (the
   *  S2b descriptor's killX/killY). */
  killLocal: Vec2;
  /** The kill point in world space (on the hull). */
  killWorldOnHull: Vec2;
}

/** World point → the hull's 1× Pixi-up frame, projected onto the outline. */
export function hullLocalKillPoint(kindId: ShipKindId, pose: WreckDeathPose, world: Vec2): Vec2 {
  const kind = getShipKind(kindId);
  const s = shipShapeScale(kind);
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const dx = world.x - pose.x;
  const dy = world.y - pose.y;
  const mx = dx * c + dy * sn;
  const my = -dx * sn + dy * c;
  return projectToOutline(shipHullOutline(kind), { x: mx / s, y: -my / s });
}

function ringArea(r: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Saturating 0..1 "how violent" from the two damage inputs. */
function violence(kb: number, rate: number): number {
  const f = (x: number): number => (x > 0 ? x / (x + 0.35) : 0);
  return 0.5 * f(kb) + 0.5 * f(rate);
}

/**
 * The deterministic piece shapes of one wreck. The server's `buildWreckPieces`
 * and the client's rebuild (from the `wrecks[]` descriptor) both call this, so
 * the client's predWorld bodies and drawn pieces match the server's bodies bit
 * for bit (#15; locked by `tests/integration/wire/wreckGeometryParity.test.ts`).
 * Runs once per wreck per side; allocates freely.
 */
export function wreckPieceGeometry(input: WreckFractureInputs): WreckPieceGeometry[] {
  const kind = getShipKind(input.kindId);
  const hull = shipHullOutline(kind);
  const s = shipShapeScale(kind);
  const fractured = fractureHull({
    hull,
    seed: input.seed >>> 0,
    killPoint: { x: input.killX, y: input.killY },
    maxPieces: FRACTURE_MAX_PIECES,
    killBlowDamage: input.killBlowDamage,
    recentDamageRate: input.recentDamageRate,
    snapChance: input.snapChance,
  });
  const hullAreaWorld = ringArea(hull) * s * s;
  const density = hullAreaWorld > 0 ? massOf(kind, 1) / hullAreaWorld : 0;
  const inset = shipTuning(kind).wreckColliderInset;
  const out: WreckPieceGeometry[] = [];
  for (let i = 0; i < fractured.length; i++) {
    const p = fractured[i]!;
    const cmx = p.centroid.x * s;
    const cmy = -p.centroid.y * s;
    let radius = 0;
    const parts: Vec2[][] = [];
    for (const part of p.convexParts) {
      const ring: Vec2[] = [];
      // The Y flip turns CCW into CW: walk backwards to stay CCW.
      for (let k = part.length - 1; k >= 0; k--) {
        const v = part[k]!;
        const x = v.x * s - cmx;
        const y = -v.y * s - cmy;
        ring.push({ x, y });
        const r = Math.sqrt(x * x + y * y);
        if (r > radius) radius = r;
      }
      parts.push(ring);
    }
    const n = p.outline.length;
    const outline: Vec2[] = [];
    const cutEdges: boolean[] = [];
    for (let j = 0; j < n; j++) {
      const v = p.outline[n - 1 - j]!;
      outline.push({ x: v.x * s - cmx, y: -v.y * s - cmy });
      // Reversed walk: new edge j is old edge (n - 2 - j) mod n.
      cutEdges.push(p.cutEdges[(n - 2 - j + n) % n] ?? false);
    }
    const area = p.area * s * s;
    const colliderParts = parts.map((ring) => insetRing(ring, inset));
    out.push({ index: i, cx: cmx, cy: cmy, parts, colliderParts, outline, cutEdges, area, mass: Math.max(1e-3, density * area), radius });
  }
  return out;
}

/** A convex ring with every vertex moved `inset` toward the ring's vertex
 *  centre (never more than half way). Every point of a shared cut edge moves
 *  into its own piece, so two neighbours' colliders start apart. */
function insetRing(ring: ReadonlyArray<Vec2>, inset: number): Vec2[] {
  let mx = 0;
  let my = 0;
  for (const v of ring) { mx += v.x; my += v.y; }
  mx /= ring.length;
  my /= ring.length;
  const out: Vec2[] = [];
  for (const v of ring) {
    const dx = v.x - mx;
    const dy = v.y - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d > 0 ? Math.max(0.5, (d - inset) / d) : 1;
    out.push({ x: mx + dx * k, y: my + dy * k });
  }
  return out;
}

/** A shared cut between two neighbouring pieces: endpoints and the unit
 *  normal from piece `i` to piece `j`, in the ship's scaled math-up frame. */
interface Seam {
  i: number;
  j: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
}

/** Collinearity / overlap tolerances for matching cut edges (ship frame, u). */
const SEAM_LINE_EPS = 0.05;
const SEAM_MIN_LEN = 0.5;
/** Cut edges of two pieces this close (u) touch (see `findSeams`). */
const SEAM_TOUCH_EPS = 0.5;

/** Every shared cut between pieces (cut edges of two pieces that lie on one
 *  line and overlap). The cut line separates the two pieces, so parting
 *  along its normal never overlaps them. */
function findSeams(geom: ReadonlyArray<WreckPieceGeometry>): Seam[] {
  const seams: Seam[] = [];
  for (let i = 0; i < geom.length; i++) {
    const gi = geom[i]!;
    const ni = gi.outline.length;
    for (let ea = 0; ea < ni; ea++) {
      if (!gi.cutEdges[ea]) continue;
      const p = gi.outline[ea]!;
      const q = gi.outline[(ea + 1) % ni]!;
      const px = p.x + gi.cx, py = p.y + gi.cy;
      const dx = q.x + gi.cx - px, dy = q.y + gi.cy - py;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < SEAM_MIN_LEN) continue;
      const ux = dx / len, uy = dy / len;
      // CCW outline: the outward normal is the edge direction turned clockwise.
      const nx = uy, ny = -ux;
      for (let j = i + 1; j < geom.length; j++) {
        const gj = geom[j]!;
        const nj = gj.outline.length;
        for (let eb = 0; eb < nj; eb++) {
          if (!gj.cutEdges[eb]) continue;
          const r = gj.outline[eb]!;
          const t = gj.outline[(eb + 1) % nj]!;
          const rx = r.x + gj.cx - px, ry = r.y + gj.cy - py;
          const tx = t.x + gj.cx - px, ty = t.y + gj.cy - py;
          if (Math.abs(rx * nx + ry * ny) > SEAM_LINE_EPS || Math.abs(tx * nx + ty * ny) > SEAM_LINE_EPS) continue;
          const s0 = Math.max(0, Math.min(rx * ux + ry * uy, tx * ux + ty * uy));
          const s1 = Math.min(len, Math.max(rx * ux + ry * uy, tx * ux + ty * uy));
          if (s1 - s0 < SEAM_MIN_LEN) continue;
          seams.push({ i, j, ax: px + ux * s0, ay: py + uy * s0, bx: px + ux * s1, by: py + uy * s1, nx, ny });
        }
      }
    }
  }
  // Neighbours whose cut edges touch without lying on one line: a fan crack
  // that ends on a zone crack leaves a T-junction, and the two sides of the
  // zone crack are jagged from different endpoints, so the pass above never
  // matches them (tuning 2026-11-13: such a pair parted only at the push
  // speed, the narrowest gap on screen). Each gets one seam at the closest
  // touch, along the outward normal of the longer of the two edges.
  const n = geom.length;
  const paired = new Uint8Array(n * n);
  for (const sm of seams) paired[sm.i * n + sm.j] = 1;
  for (let i = 0; i < n; i++) {
    const gi = geom[i]!;
    for (let j = i + 1; j < n; j++) {
      if (paired[i * n + j]) continue;
      const gj = geom[j]!;
      let best: Seam | null = null;
      let bestD = SEAM_TOUCH_EPS;
      for (let ea = 0; ea < gi.outline.length; ea++) {
        if (!gi.cutEdges[ea]) continue;
        const a0 = gi.outline[ea]!, a1 = gi.outline[(ea + 1) % gi.outline.length]!;
        const ax0 = a0.x + gi.cx, ay0 = a0.y + gi.cy, ax1 = a1.x + gi.cx, ay1 = a1.y + gi.cy;
        for (let eb = 0; eb < gj.outline.length; eb++) {
          if (!gj.cutEdges[eb]) continue;
          const b0 = gj.outline[eb]!, b1 = gj.outline[(eb + 1) % gj.outline.length]!;
          const bx0 = b0.x + gj.cx, by0 = b0.y + gj.cy, bx1 = b1.x + gj.cx, by1 = b1.y + gj.cy;
          const touch = closestTouch(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1);
          if (touch.d >= bestD) continue;
          const la = Math.sqrt((ax1 - ax0) ** 2 + (ay1 - ay0) ** 2);
          const lb = Math.sqrt((bx1 - bx0) ** 2 + (by1 - by0) ** 2);
          if (Math.max(la, lb) < SEAM_MIN_LEN) continue;
          // Outward normal of the longer edge, turned to point from i to j.
          const nx = la >= lb ? (ay1 - ay0) / la : -(by1 - by0) / lb;
          const ny = la >= lb ? -(ax1 - ax0) / la : (bx1 - bx0) / lb;
          bestD = touch.d;
          best = { i, j, ax: touch.x, ay: touch.y, bx: touch.x, by: touch.y, nx, ny };
        }
      }
      if (best) seams.push(best);
    }
  }
  return seams;
}

/** Distance between segments a and b, and the midpoint of their closest
 *  points (the touch), from the four endpoint-to-segment candidates. */
function closestTouch(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): { d: number; x: number; y: number } {
  let best = { d: Infinity, x: 0, y: 0 };
  const cand = (px: number, py: number, s0x: number, s0y: number, s1x: number, s1y: number): void => {
    const dx = s1x - s0x, dy = s1y - s0y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - s0x) * dx + (py - s0y) * dy) / l2)) : 0;
    const qx = s0x + t * dx, qy = s0y + t * dy;
    const d = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2);
    if (d < best.d) best = { d, x: (px + qx) / 2, y: (py + qy) / 2 };
  };
  cand(ax0, ay0, bx0, by0, bx1, by1);
  cand(ax1, ay1, bx0, by0, bx1, by1);
  cand(bx0, by0, ax0, ay0, ax1, ay1);
  cand(bx1, by1, ax0, ay0, ax1, ay1);
  return best;
}

export function buildWreckPieces(input: WreckBuildInput): WreckBuild {
  const kind = getShipKind(input.kindId);
  const s = shipShapeScale(kind);
  const { pose } = input;
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const toWorld = (lx: number, ly: number): Vec2 => {
    // Pixi-up 1× → math-up scaled → world.
    const mx = lx * s;
    const my = -ly * s;
    return { x: pose.x + mx * c - my * sn, y: pose.y + mx * sn + my * c };
  };

  const target = input.killWorld ?? input.attackerWorld ?? { x: pose.x, y: pose.y };
  const killLocal = hullLocalKillPoint(input.kindId, pose, target);
  const killWorldOnHull = toWorld(killLocal.x, killLocal.y);

  const fracture: WreckFractureInputs = {
    kindId: input.kindId,
    seed: input.seed >>> 0,
    killX: killLocal.x,
    killY: killLocal.y,
    killBlowDamage: input.killBlowDamage,
    recentDamageRate: input.recentDamageRate,
    snapChance: FRACTURE_SNAP_CHANCE,
  };
  const geom = wreckPieceGeometry(fracture);

  // Outward push away from the kill point: fastest there, falling off with
  // distance, scaled by hull size (#18) and by how violent the death was.
  const tuning = shipTuning(kind);
  const harder = 0.75 + 0.5 * violence(input.killBlowDamage, input.recentDamageRate);
  const pushFar = tuning.wreckPushMin * harder;
  const pushExtra = (tuning.wreckPushMax - tuning.wreckPushMin) * harder;
  const rf = WRECK_PUSH_FALLOFF_FRAC * kind.radius;
  const rf2 = rf * rf;
  const spinRng = new Rng(fnvMixU32((input.seed >>> 0) ^ 0x3ec7, 0x5));
  const spinMinR = WRECK_SPIN_MIN_RADIUS_FRAC * kind.radius;

  // The kicks are built in the ship's scaled math-up frame (the frame the
  // geometry is in), then turned into the world by the ship's angle. The
  // pieces' rigid motion (v + ω × r, ω) moves them as one body, so only the
  // kicks change how neighbours move relative to each other.
  const kx = killLocal.x * s;
  const ky = -killLocal.y * s;
  const n = geom.length;
  const kvx = new Float64Array(n);
  const kvy = new Float64Array(n);
  const kw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = geom[i]!;
    // Push away from the kill point: fastest there, falling off with
    // distance, scaled by hull size (#18) and how violent the death was.
    let ox = g.cx - kx;
    let oy = g.cy - ky;
    const ol2 = ox * ox + oy * oy;
    const ol = Math.sqrt(ol2);
    const near = rf2 / (rf2 + ol2); // 1 at the kill point → 0 far away
    const push = pushFar + pushExtra * near;
    if (ol > 1e-6) {
      ox /= ol;
      oy /= ol;
    } else {
      ox = 0;
      oy = 0;
    }
    kvx[i] = ox * push;
    kvy[i] = oy * push;
    // Spin: a slow rim speed, fastest near the kill point, seeded size
    // (0.55–1×) and direction; a bigger piece turns slower.
    const u = spinRng.u32() / 4294967296;
    const rim = tuning.wreckSeparate * (WRECK_SPIN_RIM_FAR + (WRECK_SPIN_RIM_NEAR - WRECK_SPIN_RIM_FAR) * near) * (0.55 + 0.9 * Math.abs(u - 0.5));
    const mag = rim / Math.max(g.radius, spinMinR);
    kw[i] = u < 0.5 ? -mag : mag;
  }

  // Part every pair of neighbours. The push is fastest at the kill point, so
  // a piece nearer it chases the slower neighbour beyond it along the same
  // line, and the spins turn long pieces into each other (owner review
  // 2026-11-13: pieces "slide over each other", a "V" hinge at a stern seam).
  // Each shared cut must open at `wreckSeparate` or more at BOTH ends (so
  // along all of it, spin included); where it doesn't, an equal and opposite
  // push along the cut's normal (momentum kept) makes up the difference.
  // Gauss–Seidel over the seams; a uniform expansion satisfies every seam at
  // once, so the passes converge.
  const sep = tuning.wreckSeparate;
  const seams = findSeams(geom);
  for (let it = 0; it < SEPARATE_ITERATIONS; it++) {
    let worst = 0;
    for (const sm of seams) {
      const gi = geom[sm.i]!;
      const gj = geom[sm.j]!;
      const at = (px: number, py: number): number => {
        // Relative velocity of j's and i's material at the point, along n.
        const vjx = kvx[sm.j]! - kw[sm.j]! * (py - gj.cy);
        const vjy = kvy[sm.j]! + kw[sm.j]! * (px - gj.cx);
        const vix = kvx[sm.i]! - kw[sm.i]! * (py - gi.cy);
        const viy = kvy[sm.i]! + kw[sm.i]! * (px - gi.cx);
        return (vjx - vix) * sm.nx + (vjy - viy) * sm.ny;
      };
      const wi = 1 / gi.mass;
      const wj = 1 / gj.mass;
      const open = Math.min(at(sm.ax, sm.ay), at(sm.bx, sm.by));
      if (open < sep) {
        worst = Math.max(worst, sep - open);
        const imp = (SEPARATE_AIM * sep - open) / (wi + wj);
        kvx[sm.i] = kvx[sm.i]! - sm.nx * imp * wi;
        kvy[sm.i] = kvy[sm.i]! - sm.ny * imp * wi;
        kvx[sm.j] = kvx[sm.j]! + sm.nx * imp * wj;
        kvy[sm.j] = kvy[sm.j]! + sm.ny * imp * wj;
      }
      // ...and their centres move apart too (a seam can open while one piece
      // slides along it past the other's centre).
      let dx = gj.cx - gi.cx;
      let dy = gj.cy - gi.cy;
      const dl = Math.sqrt(dx * dx + dy * dy);
      if (dl < 1e-6) continue;
      dx /= dl;
      dy /= dl;
      const apart = (kvx[sm.j]! - kvx[sm.i]!) * dx + (kvy[sm.j]! - kvy[sm.i]!) * dy;
      const want = CENTRE_PART * sep;
      if (apart >= want) continue;
      worst = Math.max(worst, want - apart);
      const imp = (SEPARATE_AIM * want - apart) / (wi + wj);
      kvx[sm.i] = kvx[sm.i]! - dx * imp * wi;
      kvy[sm.i] = kvy[sm.i]! - dy * imp * wi;
      kvx[sm.j] = kvx[sm.j]! + dx * imp * wj;
      kvy[sm.j] = kvy[sm.j]! + dy * imp * wj;
    }
    if (worst === 0) break;
  }

  const pieces: WreckPieceSpec[] = [];
  for (let i = 0; i < n; i++) {
    const g = geom[i]!;
    // Centroid: the ship's scaled math-up frame → rotate → world.
    const centre = { x: pose.x + g.cx * c - g.cy * sn, y: pose.y + g.cx * sn + g.cy * c };
    const rx = centre.x - pose.x;
    const ry = centre.y - pose.y;
    pieces.push({
      index: g.index,
      x: centre.x,
      y: centre.y,
      vx: pose.vx - pose.angvel * ry,
      vy: pose.vy + pose.angvel * rx,
      angle: pose.angle,
      angvel: pose.angvel,
      kickVx: kvx[i]! * c - kvy[i]! * sn,
      kickVy: kvx[i]! * sn + kvy[i]! * c,
      kickAngvel: kw[i]!,
      parts: g.parts,
      colliderParts: g.colliderParts,
      area: g.area,
      mass: g.mass,
      radius: g.radius,
    });
  }
  return { pieces, killLocal, killWorldOnHull, fracture };
}
