/**
 * Capital fracture, slice S1 (docs/architecture/capital-destruction.md).
 *
 * `fractureHull` splits a hull outline into wreck pieces: seeded Voronoi cells
 * clustered around the killing blow, clipped to the (possibly concave) hull,
 * optional straight section cuts, jagged cut edges and a convex decomposition
 * per piece for Rapier. Since v2 a straight primary break line runs through
 * the kill point across the keel, a seeded chance snaps the hull cleanly in
 * two along it, and the piece count is earned from hull size, the killing
 * blow and the recent damage rate (doc §6). Pure and DETERMINISTIC: the
 * server and every client run it from the same `FractureInput` and get
 * bit-identical pieces, so no geometry ever goes on the wire.
 *
 * Determinism rules (keep them when editing):
 *  - only + − × ÷ and `Math.sqrt` / `Math.round` / `Math.abs` / min / max in
 *    this path (IEEE-exact on every engine); never sin/cos/atan2/pow/exp;
 *  - randomness from the integer mulberry32 `Rng` (`u32 / 2^32` is exact);
 *  - fixed iteration order (indexed loops; a `Map` is used for lookups only);
 *    every sort has a total tie-break;
 *  - output vertices snap to `FRACTURE_QUANTUM` (1/64 u); after that every
 *    orientation test is exact;
 *  - poly-decomp: `quickDecomp` / `makeCCW` only (its `removeCollinearPoints`
 *    uses `Math.acos`).
 * Any change to the output must bump `FRACTURE_ALGO_VERSION` (the golden test
 * in `fractureHull.test.ts` fails first).
 *
 * Not hot-loop code: it runs once per death (allocates freely, invariant #14
 * applies only to what callers do per frame with the result, which is plain
 * read-only data).
 */
import decomp from 'poly-decomp';
import { Rng, fnvMixU32 } from '../random/rng.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Bump on ANY change to the produced geometry (rides the S2 descriptor).
 *  v2: primary break line through the kill point, seeded clean snap,
 *  damage-driven piece count.
 *  v3: the kill point is projected onto the hull outline first (a real hit
 *  lands on the hull's edge, never inside it); the seed pair sits just inside
 *  the edge; a primary line that would only clip a sliver off a bow or stern
 *  tip turns to run through the hull's middle instead. */
export const FRACTURE_ALGO_VERSION = 3;
/** Default chance that a hull snaps cleanly in two along the primary line
 *  instead of shattering (owner: "just make it a chance"). */
export const FRACTURE_SNAP_CHANCE = 0.2;
/** Output grid: every vertex is a multiple of this. */
export const FRACTURE_QUANTUM = 1 / 64;
/** Hard ceiling on pieces (the S2 wire carries the piece index in a u8). */
export const FRACTURE_MAX_PIECES = 64;

/** Seed-density falloff radius as a fraction of sqrt(hull area). */
const FALLOFF_FRAC = 0.18;
/** Minimum acceptance far from the blast, so the far end still splits. */
const ACCEPT_FLOOR = 0.035;
/** Below this many seeds the falloff radius widens by (FEW_SEEDS / count)². */
const FEW_SEEDS = 12;
/** Minimum seed spacing as a fraction of sqrt(hull area). */
const MIN_SEED_SEP_FRAC = 0.03;
/** Rejection-sampling attempts per requested seed. */
const ATTEMPTS_PER_SEED = 400;
/** Jag sub-segment target length as a fraction of sqrt(hull area). */
const JAG_SEG_FRAC = 0.02;
/** Maximum midpoint-subdivision depth (2^depth segments per cut edge). */
const JAG_MAX_DEPTH = 4;
/** Midpoint displacement amplitude per level, as a fraction of the sub-segment length. */
const JAG_ROUGHNESS = 0.22;

/** Largest tilt of the primary line off square-across-the-keel, as the
 *  keel-wise component of its (unnormalised) direction: 0.35 ≈ 19°. */
const PRIMARY_TILT = 0.35;
/** Hull radius at which the size factor saturates (a battleship is ~2900 u). */
const SIZE_FULL_RADIUS = 3000;
/** Half-saturation of the damage inputs: f(x) = x / (x + DAMAGE_KNEE). */
const DAMAGE_KNEE = 0.35;
/** How far the seeded draw can move the shatter amount either way. */
const COUNT_SPREAD = 0.5;
/** Fewest pieces a (non-snap) damage-driven fracture aims for. */
const MIN_TARGET = 3;
/** v3: a primary line across the keel that leaves less than this fraction of
 *  the hull on one side (a hit near a bow or stern tip) turns to run from the
 *  kill point through the hull's middle instead. */
const PRIMARY_MIN_SIDE = 0.03;

const EDGE_HULL = 0;
const EDGE_VORONOI = 1;
const EDGE_SECTION = 2;
const EDGE_PRIMARY = 3;

export interface FractureCut {
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface FractureInput {
  /** Hull outline in local coordinates, either winding; concave allowed. */
  readonly hull: ReadonlyArray<readonly [number, number]>;
  /** u32 seed (the server picks it; every client regenerates from it). */
  readonly seed: number;
  /** Where the killing blow landed, in the hull's local frame. Since v3 it
   *  is projected onto the hull outline (`projectToOutline`) before use, so
   *  a point inside the hull or out at the shield radius lands on the edge. */
  readonly killPoint: Vec2;
  /** Optional section boundaries; each is the infinite line through a→b.
   *  Section cuts are straight (bulkheads); only Voronoi cuts are jagged. */
  readonly sectionCuts?: ReadonlyArray<FractureCut>;
  /** Cap on real fragments (clamped to 1..FRACTURE_MAX_PIECES). In
   *  fixed-count mode (none of the three damage inputs below given) it is
   *  also the target count. */
  readonly maxPieces: number;
  /** Hull size in local units. Default: the farthest outline vertex from the
   *  local origin (the ship's centre). Bigger hulls break into more pieces. */
  readonly hullRadius?: number;
  /** The killing blow's damage over the ship's max hull HP, 0..1+. */
  readonly killBlowDamage?: number;
  /** Damage over the last few seconds, normalised (1 ≈ max hull HP in that
   *  window), 0..1+. A slow grind is near 0. */
  readonly recentDamageRate?: number;
  /** Chance (0..1) of a clean snap in two along the primary line instead of
   *  a shatter. Default `FRACTURE_SNAP_CHANCE`. */
  readonly snapChance?: number;
}

/** The seeded decisions taken before any geometry (exposed for S2 and tests). */
export interface FracturePlan {
  /** True: the hull snaps cleanly in two along the primary line. */
  readonly snap: boolean;
  /** Piece count aimed for (≤ the cap; 2 when snapping). */
  readonly targetPieces: number;
  /** The primary break line: through `point` (the kill point, on the hull
   *  outline) along unit `dir`, roughly across the keel (through the hull's
   *  middle for a hit on a bow or stern tip). Null when the cap is 1. */
  readonly primary: { readonly point: Vec2; readonly dir: Vec2 } | null;
}

export interface FracturePiece {
  /** CCW outline (positive shoelace area), quantised, in the hull's frame. */
  readonly outline: Vec2[];
  /** `cutEdges[i]` is true when edge outline[i] → outline[i+1] is a new cut
   *  (glows molten in S3); false when it is part of the original hull. */
  readonly cutEdges: boolean[];
  /** Convex CCW parts tiling the outline (one Rapier collider each). */
  readonly convexParts: Vec2[][];
  readonly area: number;
  readonly centroid: Vec2;
}

/** Internal vertex: position + kind of the edge that starts here. */
interface P {
  x: number;
  y: number;
  k: number;
}

export function fractureHull(input: FractureInput): FracturePiece[] {
  const hull = normaliseHull(input.hull);
  if (hull.length < 3) return [];
  const plan = planFor(input, hull);
  const cap = plan.snap ? clampCap(input.maxPieces) : plan.targetPieces;
  const hullArea = ringArea(hull);
  const scale = Math.sqrt(hullArea);
  const cuts = plan.snap ? [] : (input.sectionCuts ?? []);
  const primary = plan.primary ? primaryCut(plan.primary) : null;
  const kill = projectRing(hull, input.killPoint.x, input.killPoint.y);

  // Seeds: one prefix-stable stream, so fewer seeds = a prefix of more seeds.
  // A clean snap has none: the primary line alone splits the hull.
  const allSeeds = plan.snap ? [] : sampleSeeds(hull, hullArea, input.seed >>> 0, kill, cap, plan.primary);

  // Retry with fewer seeds, then without section cuts, then without the
  // primary line, until the cap holds.
  let useCuts = cuts.length > 0;
  let usePrimary = primary !== null;
  let n = allSeeds.length;
  for (;;) {
    const lines: FractureLine[] = [];
    if (usePrimary) lines.push(primary!);
    if (useCuts) for (const c of cuts) lines.push(sectionLine(c));
    const rings = splitIntoPieces(hull, lines, allSeeds, n);
    const minArea = Math.max(4 * FRACTURE_QUANTUM * FRACTURE_QUANTUM, hullArea * 1e-6);
    const quantised = quantiseRings(rings, minArea);
    if (quantised.length <= cap) {
      const jagged = jagCutEdges(quantised, input.seed >>> 0, scale);
      return jagged.map(toPiece);
    }
    if (n > 1) n = Math.max(1, n - (quantised.length - cap));
    else if (useCuts) {
      useCuts = false;
      n = allSeeds.length;
    } else if (usePrimary) {
      usePrimary = false;
      n = allSeeds.length;
    } else {
      // Unreachable for a simple hull (≤ one seed, no lines = the hull itself).
      return [toPiece(quantiseRings([hull], 0)[0]!)];
    }
  }
}

/** The seeded decisions `fractureHull` takes for `input`: snap or shatter,
 *  target piece count and the primary break line. */
export function fracturePlan(input: FractureInput): FracturePlan {
  return planFor(input, normaliseHull(input.hull));
}

/**
 * The nearest point to `p` on the hull OUTLINE (its edges), snapped to
 * `FRACTURE_QUANTUM`. A real hit lands on the hull's edge: a point inside
 * the hull, or out at the shield radius, moves to the closest edge point.
 * Pure and deterministic (arithmetic only, edges in a fixed order, the
 * first edge wins a tie). `fractureHull` applies it to every kill point.
 */
export function projectToOutline(hull: ReadonlyArray<readonly [number, number]>, p: Vec2): Vec2 {
  const ring = normaliseHull(hull);
  if (ring.length === 0) return { x: q(p.x), y: q(p.y) };
  return projectRing(ring, p.x, p.y);
}

// ───────────────────────────── plan ─────────────────────────────

function clampCap(maxPieces: number): number {
  return Math.max(1, Math.min(FRACTURE_MAX_PIECES, Math.floor(maxPieces)));
}

/** Saturating 0..1 response to a 0..1+ damage input. */
function damageResponse(x: number | undefined): number {
  const v = x !== undefined && x > 0 ? x : 0;
  return v / (v + DAMAGE_KNEE);
}

function planFor(input: FractureInput, hull: P[]): FracturePlan {
  const cap = clampCap(input.maxPieces);
  // One decision stream, drawn in a fixed order whatever the mode.
  const rng = new Rng(fnvMixU32((input.seed >>> 0) ^ 0xb4ea7, 0x2));
  const snapDraw = rng.u32() / 4294967296;
  const tiltDraw = (rng.u32() % 2001) - 1000; // integer in [-1000, 1000]
  const countDraw = rng.u32() / 4294967296;

  // Primary line: through the kill point (on the outline, v3), across the
  // keel, tilted by the seed.
  let primary: FracturePlan['primary'] = null;
  if (cap >= 2 && hull.length >= 3) {
    const kill = projectRing(hull, input.killPoint.x, input.killPoint.y);
    const keel = keelAxis(hull);
    const t = (tiltDraw / 1000) * PRIMARY_TILT;
    let dx = -keel.y + keel.x * t;
    let dy = keel.x + keel.y * t;
    let len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
    // A hit near a bow or stern tip: a line across the keel there clips
    // only a sliver. Run it from the kill point through the hull's middle
    // (vertex mean) instead, keeping the seeded tilt.
    if (minSideFrac(hull, kill, dx, dy) < PRIMARY_MIN_SIDE) {
      let mx = 0;
      let my = 0;
      for (const p of hull) {
        mx += p.x;
        my += p.y;
      }
      mx /= hull.length;
      my /= hull.length;
      let ux = mx - kill.x;
      let uy = my - kill.y;
      len = Math.sqrt(ux * ux + uy * uy);
      if (len > 0) {
        ux /= len;
        uy /= len;
        const h = t * 0.05;
        dx = ux - uy * h;
        dy = uy + ux * h;
        len = Math.sqrt(dx * dx + dy * dy);
        dx /= len;
        dy /= len;
      }
    }
    primary = { point: kill, dir: { x: dx, y: dy } };
  }

  const chance = input.snapChance ?? FRACTURE_SNAP_CHANCE;
  const snap = primary !== null && snapDraw < chance;

  let targetPieces = cap;
  const damageDriven =
    input.hullRadius !== undefined || input.killBlowDamage !== undefined || input.recentDamageRate !== undefined;
  if (snap) targetPieces = Math.min(cap, 2);
  else if (damageDriven) {
    let r = input.hullRadius;
    if (r === undefined) {
      let r2 = 0;
      for (const p of hull) r2 = Math.max(r2, p.x * p.x + p.y * p.y);
      r = Math.sqrt(r2);
    }
    const sizeF = Math.sqrt(Math.min(1, Math.max(0, r) / SIZE_FULL_RADIUS));
    // Violence: how hard and how fast the ship died, 0..1.
    const violence = 0.5 * damageResponse(input.killBlowDamage) + 0.5 * damageResponse(input.recentDamageRate);
    const x = Math.min(1, Math.max(0, 0.1 + 0.9 * violence + (countDraw - 0.5) * COUNT_SPREAD));
    const want = MIN_TARGET + Math.floor(sizeF * (FRACTURE_MAX_PIECES - MIN_TARGET) * x * x);
    targetPieces = Math.max(1, Math.min(cap, want));
  }
  return { snap, targetPieces, primary };
}

/** Nearest point on the ring's edges to (x, y), snapped to the quantum. */
function projectRing(hull: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): Vec2 {
  let bestD = Infinity;
  let bx = x;
  let by = y;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - a.x) * ex + (y - a.y) * ey) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + ex * t;
    const py = a.y + ey * t;
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestD) {
      bestD = d;
      bx = px;
      by = py;
    }
  }
  return { x: q(bx), y: q(by) };
}

/** The smaller share (0..0.5) of the hull's area on either side of the line
 *  through `p` along unit (dx, dy). */
function minSideFrac(hull: P[], p: Vec2, dx: number, dy: number): number {
  const total = ringArea(hull);
  if (total <= 0) return 0;
  const nx = -dy;
  const ny = dx;
  let a = 0;
  for (const part of splitByLine(hull, nx, ny, nx * p.x + ny * p.y, EDGE_PRIMARY)) a += ringArea(part);
  const f = a / total;
  return f < 0.5 ? f : 1 - f;
}

/** Unit direction of the hull's long axis: the major eigenvector of the
 *  vertex covariance (closed form, sqrt only). */
function keelAxis(hull: P[]): Vec2 {
  let mx = 0;
  let my = 0;
  for (const p of hull) {
    mx += p.x;
    my += p.y;
  }
  mx /= hull.length;
  my /= hull.length;
  let a = 0;
  let b = 0;
  let c = 0;
  for (const p of hull) {
    const dx = p.x - mx;
    const dy = p.y - my;
    a += dx * dx;
    b += dx * dy;
    c += dy * dy;
  }
  const h = (a - c) / 2;
  const lam = (a + c) / 2 + Math.sqrt(h * h + b * b);
  // Two candidate eigenvectors; take the better-conditioned one.
  const v1x = b;
  const v1y = lam - a;
  const v2x = lam - c;
  const v2y = b;
  const n1 = v1x * v1x + v1y * v1y;
  const n2 = v2x * v2x + v2y * v2y;
  if (n1 === 0 && n2 === 0) return { x: 0, y: 1 };
  if (n1 >= n2) {
    const l = Math.sqrt(n1);
    return { x: v1x / l, y: v1y / l };
  }
  const l = Math.sqrt(n2);
  return { x: v2x / l, y: v2y / l };
}

/** A splitting line `nx·x + ny·y = c`; both sides are kept. */
interface FractureLine {
  nx: number;
  ny: number;
  c: number;
  kind: number;
}

function primaryCut(p: NonNullable<FracturePlan['primary']>): FractureLine {
  const nx = -p.dir.y;
  const ny = p.dir.x;
  return { nx, ny, c: nx * p.point.x + ny * p.point.y, kind: EDGE_PRIMARY };
}

function sectionLine(cut: FractureCut): FractureLine {
  const nx = -(cut.b.y - cut.a.y);
  const ny = cut.b.x - cut.a.x;
  return { nx, ny, c: nx * cut.a.x + ny * cut.a.y, kind: EDGE_SECTION };
}

// ───────────────────────────── seeds ─────────────────────────────

function sampleSeeds(
  hull: P[],
  hullArea: number,
  seed: number,
  kill: Vec2,
  count: number,
  primary: FracturePlan['primary'],
): Vec2[] {
  const rng = new Rng(seed ^ 0x5eed5eed);
  const f01 = (): number => rng.u32() / 4294967296;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const s = Math.sqrt(hullArea);
  // Few seeds spread wider (a few big hulks, not one hulk and slivers);
  // the density still peaks at the kill point.
  const widen = Math.max(1, FEW_SEEDS / count);
  const fall = FALLOFF_FRAC * s * widen * widen;
  const r2 = fall * fall;
  const sep2 = MIN_SEED_SEP_FRAC * s * (MIN_SEED_SEP_FRAC * s);
  const seeds: Vec2[] = [];
  if (primary) {
    // A seed pair straddling the primary line at the kill point: their
    // bisector IS the line, so the smallest pieces meet there on both sides.
    // v3: the kill point is on the outline, so centre the pair a little
    // inside the hull along the line (the bisector stays on the line).
    const off = 0.5 * MIN_SEED_SEP_FRAC * s;
    const nx = -primary.dir.y * off;
    const ny = primary.dir.x * off;
    let cx = kill.x;
    let cy = kill.y;
    for (const sg of [1, -1]) {
      const ix = kill.x + sg * primary.dir.x * 2 * off;
      const iy = kill.y + sg * primary.dir.y * 2 * off;
      if (pointInRing(hull, ix, iy)) {
        cx = ix;
        cy = iy;
        break;
      }
    }
    for (const sg of [1, -1]) {
      const x = cx + sg * nx;
      const y = cy + sg * ny;
      if (seeds.length < count && pointInRing(hull, x, y)) seeds.push({ x, y });
    }
  } else if (pointInRing(hull, kill.x, kill.y)) seeds.push({ x: kill.x, y: kill.y });
  const attempts = ATTEMPTS_PER_SEED * count;
  for (let a = 0; a < attempts && seeds.length < count; a++) {
    const x = minX + (maxX - minX) * f01();
    const y = minY + (maxY - minY) * f01();
    const u = f01();
    if (!pointInRing(hull, x, y)) continue;
    const dx = x - kill.x;
    const dy = y - kill.y;
    const accept = Math.max(ACCEPT_FLOOR, r2 / (r2 + dx * dx + dy * dy));
    if (u >= accept) continue;
    let ok = true;
    for (const q of seeds) {
      const ex = q.x - x;
      const ey = q.y - y;
      if (ex * ex + ey * ey < sep2) {
        ok = false;
        break;
      }
    }
    if (ok) seeds.push({ x, y });
  }
  if (seeds.length === 0) seeds.push({ x: hull[0]!.x, y: hull[0]!.y });
  return seeds;
}

// ──────────────────────── sections + Voronoi ────────────────────────

function splitIntoPieces(hull: P[], lines: ReadonlyArray<FractureLine>, seeds: Vec2[], n: number): P[][] {
  let sections: P[][] = [hull];
  for (const { nx, ny, c, kind } of lines) {
    if (nx === 0 && ny === 0) continue;
    const next: P[][] = [];
    for (const s of sections) {
      for (const part of splitByLine(s, nx, ny, c, kind)) next.push(part);
      for (const part of splitByLine(s, -nx, -ny, -c, kind)) next.push(part);
    }
    sections = next;
  }

  const out: P[][] = [];
  for (const section of sections) {
    const local: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const sd = seeds[i]!;
      if (pointInRing(section, sd.x, sd.y)) local.push(sd);
    }
    if (local.length <= 1) {
      out.push(section);
      continue;
    }
    const box = ringBox(section);
    for (let i = 0; i < local.length; i++) {
      const si = local[i]!;
      const neighbours = voronoiNeighbours(local, i, box);
      let pieces: P[][] = [section];
      for (const j of neighbours) {
        const sj = local[j]!;
        // Keep the side closer to si: (p − m)·(sj − si) < 0.
        const nx = sj.x - si.x;
        const ny = sj.y - si.y;
        const mx = (si.x + sj.x) / 2;
        const my = (si.y + sj.y) / 2;
        const c = nx * mx + ny * my;
        const next: P[][] = [];
        for (const p of pieces) for (const q of splitByLine(p, nx, ny, c, EDGE_VORONOI)) next.push(q);
        pieces = next;
        if (pieces.length === 0) break;
      }
      for (const p of pieces) out.push(p);
    }
  }
  return out;
}

/** Indices j whose bisector with seed i bounds i's (convex) Voronoi cell,
 *  in ascending order. The cell starts as `box` and is clipped by every
 *  bisector half-plane (convex Sutherland–Hodgman is exact for this). */
function voronoiNeighbours(seeds: Vec2[], i: number, box: [number, number, number, number]): number[] {
  const si = seeds[i]!;
  const [x0, y0, x1, y1] = box;
  const padX = (x1 - x0) * 0.5 + 1;
  const padY = (y1 - y0) * 0.5 + 1;
  // cell vertices with the index of the bisector that made the edge starting there (-1 = box)
  let cell: Array<{ x: number; y: number; j: number }> = [
    { x: x0 - padX, y: y0 - padY, j: -1 },
    { x: x1 + padX, y: y0 - padY, j: -1 },
    { x: x1 + padX, y: y1 + padY, j: -1 },
    { x: x0 - padX, y: y1 + padY, j: -1 },
  ];
  for (let j = 0; j < seeds.length && cell.length > 0; j++) {
    if (j === i) continue;
    const sj = seeds[j]!;
    const nx = sj.x - si.x;
    const ny = sj.y - si.y;
    const c = nx * ((si.x + sj.x) / 2) + ny * ((si.y + sj.y) / 2);
    const next: typeof cell = [];
    for (let v = 0; v < cell.length; v++) {
      const a = cell[v]!;
      const b = cell[(v + 1) % cell.length]!;
      const da = nx * a.x + ny * a.y - c;
      const db = nx * b.x + ny * b.y - c;
      if (da <= 0) next.push(a);
      if ((da <= 0) !== (db <= 0)) {
        const t = da / (da - db);
        // Entering (a out): the edge from here continues a's edge; leaving: bisector j.
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, j: da <= 0 ? j : a.j });
      }
    }
    cell = next;
  }
  const js: number[] = [];
  for (const v of cell) if (v.j >= 0 && js.indexOf(v.j) < 0) js.push(v.j);
  js.sort((a, b) => a - b);
  return js;
}

// ───────────────────── robust split of a simple polygon by a line ─────────────────────

interface Node {
  x: number;
  y: number;
  k: number;
  /** 0 = original vertex, 1 = entering crossing, 2 = exiting crossing */
  cross: number;
  t: number;
  tk: number;
  ring: number;
  partner: number;
}

/**
 * Parts of the simple CCW polygon `poly` where `nx·x + ny·y − c < 0`, as
 * separate simple CCW polygons. Unlike Sutherland–Hodgman this never joins
 * disjoint parts with a zero-width bridge: crossings are sorted along the line
 * and paired into inside intervals, and each part is traced through them.
 * A vertex exactly ON the line counts as outside (symbolic perturbation), and
 * ties along the line are broken by the perturbation's first-order term, so
 * the pairing is consistent even through vertices.
 */
function splitByLine(poly: P[], nx: number, ny: number, c: number, newKind: number): P[][] {
  const n = poly.length;
  const d: number[] = new Array<number>(n);
  let anyIn = false;
  let anyOut = false;
  for (let i = 0; i < n; i++) {
    const di = nx * poly[i]!.x + ny * poly[i]!.y - c;
    d[i] = di;
    if (di < 0) anyIn = true;
    else anyOut = true;
  }
  if (!anyIn) return [];
  if (!anyOut) return [poly];

  const ux = -ny;
  const uy = nx;
  const ring: Node[] = [];
  const crossings: Node[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const da = d[i]!;
    const db = d[(i + 1) % n]!;
    ring.push({ x: a.x, y: a.y, k: a.k, cross: 0, t: 0, tk: 0, ring: ring.length, partner: -1 });
    const aIn = da < 0;
    const bIn = db < 0;
    if (aIn === bIn) continue;
    // Always interpolate from the OUT end to the IN end, so a shared edge
    // crossed from either side yields the bit-identical point.
    const o = aIn ? b : a;
    const q = aIn ? a : b;
    const dO = aIn ? db : da;
    const dQ = aIn ? da : db;
    const s = dO / (dO - dQ);
    const x = o.x + (q.x - o.x) * s;
    const y = o.y + (q.y - o.y) * s;
    const node: Node = {
      x,
      y,
      k: aIn ? newKind : a.k,
      cross: aIn ? 2 : 1,
      t: x * ux + y * uy,
      tk: ((q.x - o.x) * ux + (q.y - o.y) * uy) / (dO - dQ),
      ring: ring.length,
      partner: -1,
    };
    ring.push(node);
    crossings.push(node);
  }
  crossings.sort((p, q) => p.t - q.t || p.tk - q.tk || p.ring - q.ring);
  for (let m = 0; m + 1 < crossings.length; m += 2) {
    const p = crossings[m]!;
    const q = crossings[m + 1]!;
    if (p.cross === q.cross) return [sutherlandHodgman(poly, d, newKind)];
    p.partner = q.ring;
    q.partner = p.ring;
  }

  const visited = new Uint8Array(ring.length);
  const out: P[][] = [];
  for (const start of crossings) {
    if (start.cross !== 1 || visited[start.ring]) continue;
    const piece: P[] = [];
    let idx = start.ring;
    let guard = ring.length + 1;
    while (!visited[idx] && guard-- > 0) {
      visited[idx] = 1;
      const nd = ring[idx]!;
      piece.push({ x: nd.x, y: nd.y, k: nd.k });
      if (nd.cross === 2) idx = nd.partner;
      else idx = (idx + 1) % ring.length;
      // Skip outside original vertices (only reachable through an entering crossing).
    }
    const cleaned = dedupe(piece);
    if (cleaned.length >= 3 && ringArea(cleaned) > 0) out.push(cleaned);
  }
  return out;
}

/** Fallback for a degenerate crossing pairing (never seen in tests). */
function sutherlandHodgman(poly: P[], d: number[], newKind: number): P[] {
  const out: P[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const da = d[i]!;
    const db = d[(i + 1) % n]!;
    if (da < 0) out.push({ x: a.x, y: a.y, k: db < 0 ? a.k : newKind });
    if ((da < 0) !== (db < 0)) {
      const s = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, k: da < 0 ? newKind : a.k });
    }
  }
  return dedupe(out);
}

// ───────────────────────────── quantise ─────────────────────────────

function q(v: number): number {
  return Math.round(v / FRACTURE_QUANTUM) * FRACTURE_QUANTUM;
}

function quantiseRings(rings: P[][], minArea: number): P[][] {
  const out: P[][] = [];
  for (const r of rings) {
    const qr = dedupe(r.map((p) => ({ x: q(p.x), y: q(p.y), k: p.k })));
    const clean = stripSpikes(qr);
    if (clean.length >= 3 && ringArea(clean) > minArea) out.push(clean);
  }
  return out;
}

// ───────────────────────────── jagged edges ─────────────────────────────

function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  const ia = Math.round(ax / FRACTURE_QUANTUM);
  const ja = Math.round(ay / FRACTURE_QUANTUM);
  const ib = Math.round(bx / FRACTURE_QUANTUM);
  const jb = Math.round(by / FRACTURE_QUANTUM);
  return ia < ib || (ia === ib && ja < jb) ? `${ia},${ja},${ib},${jb}` : `${ib},${jb},${ia},${ja}`;
}

/** Jag polyline interior points from canonical a → b (a lexicographically first). */
function jagPoints(a: Vec2, b: Vec2, seed: number, segLen: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  let depth = 0;
  let seg = len;
  while (seg > segLen * 2 && depth < JAG_MAX_DEPTH) {
    seg /= 2;
    depth++;
  }
  if (depth === 0) return [];
  const N = 1 << depth;
  const off = new Array<number>(N + 1).fill(0);
  let h = fnvMixU32(seed ^ 0x9e3779b9, Math.round(a.x / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(a.y / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(b.x / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(b.y / FRACTURE_QUANTUM) >>> 0);
  const rng = new Rng(h);
  for (let lvl = 1; lvl <= depth; lvl++) {
    const step = N >> lvl;
    const amp = (JAG_ROUGHNESS * len) / (1 << lvl);
    for (let i = step; i < N; i += 2 * step) {
      const r = rng.u32() / 4294967296;
      off[i] = (off[i - step]! + off[i + step]!) / 2 + (r * 2 - 1) * amp;
    }
  }
  const px = -dy / len;
  const py = dx / len;
  const pts: Vec2[] = [];
  for (let i = 1; i < N; i++) {
    const t = i / N;
    pts.push({ x: q(a.x + dx * t + px * off[i]!), y: q(a.y + dy * t + py * off[i]!) });
  }
  return pts;
}

function jagCutEdges(rings: P[][], seed: number, scale: number): P[][] {
  // Count each Voronoi cut edge; only edges shared by exactly two pieces are
  // jagged, so both neighbours always draw the same line.
  const count = new Map<string, number>();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (r[i]!.k !== EDGE_VORONOI) continue;
      const b = r[(i + 1) % r.length]!;
      const key = edgeKey(r[i]!.x, r[i]!.y, b.x, b.y);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const segLen = JAG_SEG_FRAC * scale;
  const cache = new Map<string, Vec2[]>();
  const straight = new Set<string>();
  const build = (r: P[]): { ring: P[]; keys: string[] } => {
    const out: P[] = [];
    const keys: string[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      out.push(a);
      if (a.k !== EDGE_VORONOI) continue;
      const key = edgeKey(a.x, a.y, b.x, b.y);
      if (count.get(key) !== 2 || straight.has(key)) continue;
      const forward = a.x < b.x || (a.x === b.x && a.y < b.y);
      let pts = cache.get(key);
      if (!pts) {
        pts = forward ? jagPoints(a, b, seed, segLen) : jagPoints(b, a, seed, segLen);
        cache.set(key, pts);
      }
      if (pts.length === 0) continue;
      keys.push(key);
      if (forward) for (let m = 0; m < pts.length; m++) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: EDGE_VORONOI });
      else for (let m = pts.length - 1; m >= 0; m--) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: EDGE_VORONOI });
    }
    return { ring: stripSpikes(dedupe(out)), keys };
  };
  // Straighten (globally, so both sides agree) any jag that breaks a piece.
  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    for (const r of rings) {
      const { ring, keys } = build(r);
      if (keys.length > 0 && !isSimpleRing(ring)) {
        for (const k of keys) straight.add(k);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rings.map((r) => build(r).ring);
}

// ───────────────────────────── piece output ─────────────────────────────

function toPiece(r: P[]): FracturePiece {
  const outline = r.map((p) => ({ x: p.x, y: p.y }));
  const cutEdges = r.map((p) => p.k !== EDGE_HULL);
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const n = outline[(i + 1) % outline.length]!;
    const cr = p.x * n.y - n.x * p.y;
    a2 += cr;
    cx += (p.x + n.x) * cr;
    cy += (p.y + n.y) * cr;
  }
  const area = a2 / 2;
  return {
    outline,
    cutEdges,
    convexParts: convexDecompose(outline, area),
    area,
    centroid: { x: cx / (3 * a2), y: cy / (3 * a2) },
  };
}

function convexDecompose(outline: Vec2[], area: number): Vec2[][] {
  // Strip exactly-collinear vertices (exact on the 1/64 grid).
  const pts: [number, number][] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[(i - 1 + n) % n]!;
    const b = outline[i]!;
    const c = outline[(i + 1) % n]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) pts.push([b.x, b.y]);
  }
  if (pts.length >= 3) {
    decomp.makeCCW(pts);
    const parts = decomp.quickDecomp(pts);
    let sum = 0;
    let convex = parts.length > 0;
    for (const part of parts) {
      sum += tupleArea(part);
      if (!isConvexTuples(part)) convex = false;
    }
    if (convex && Math.abs(sum - area) <= Math.abs(area) * 1e-9 + 1e-9) {
      return parts.map((part) => part.map(([x, y]) => ({ x, y })));
    }
  }
  return earClip(outline);
}

/** Fallback: ear clipping (triangles are convex). Exact on the 1/64 grid. */
function earClip(outline: Vec2[]): Vec2[][] {
  const idx: number[] = [];
  for (let i = 0; i < outline.length; i++) idx.push(i);
  const tris: Vec2[][] = [];
  let guard = outline.length * outline.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = outline[idx[(i - 1 + idx.length) % idx.length]!]!;
      const b = outline[idx[i]!]!;
      const c = outline[idx[(i + 1) % idx.length]!]!;
      if (orient(a, b, c) <= 0) continue;
      let blocked = false;
      for (let j = 0; j < idx.length && !blocked; j++) {
        const p = outline[idx[j]!]!;
        if (p === a || p === b || p === c) continue;
        if (orient(a, b, p) >= 0 && orient(b, c, p) >= 0 && orient(c, a, p) >= 0) blocked = true;
      }
      if (blocked) continue;
      tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) {
    const [a, b, c] = [outline[idx[0]!]!, outline[idx[1]!]!, outline[idx[2]!]!];
    if (orient(a, b, c) > 0) tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
  }
  return tris;
}

// ───────────────────────────── geometry helpers ─────────────────────────────

function normaliseHull(hull: ReadonlyArray<readonly [number, number]>): P[] {
  let ring = dedupe(hull.map(([x, y]) => ({ x, y, k: EDGE_HULL })));
  if (ringArea(ring) < 0) ring = ring.reverse();
  return ring;
}

/** Drop consecutive duplicate vertices (keeping the later one's edge kind). */
function dedupe(r: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const nx = r[(i + 1) % r.length]!;
    if (r.length > 1 && p.x === nx.x && p.y === nx.y) continue;
    out.push(p);
  }
  return out;
}

/** Remove zero-width spikes (b where a→b→c folds straight back). */
function stripSpikes(r: P[]): P[] {
  const pts = r.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (cr === 0 && dot < 0) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
    const d = dedupe(pts);
    if (d.length !== pts.length) {
      pts.length = 0;
      for (const p of d) pts.push(p);
      changed = true;
    }
  }
  return pts;
}

function ringArea(r: ReadonlyArray<{ x: number; y: number }>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function tupleArea(r: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function isConvexTuples(r: ReadonlyArray<readonly [number, number]>): boolean {
  if (r.length < 3) return false;
  let span = 0;
  for (const p of r) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * span * span;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const c = r[(i + 2) % r.length]!;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < -eps) return false;
  }
  return tupleArea(r) > 0;
}

function ringBox(r: P[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of r) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

function pointInRing(r: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!;
    const b = r[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orient(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segTouch(a: P, b: P, c: P, d: P): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: P, s: P, e: P): boolean =>
    Math.min(s.x, e.x) <= p.x && p.x <= Math.max(s.x, e.x) && Math.min(s.y, e.y) <= p.y && p.y <= Math.max(s.y, e.y);
  return (o1 === 0 && on(c, a, b)) || (o2 === 0 && on(d, a, b)) || (o3 === 0 && on(a, c, d)) || (o4 === 0 && on(b, c, d));
}

/** Exact (on the 1/64 grid) simplicity test: no repeated vertex, no
 *  touching non-adjacent edges, positive area. O(n²); n is small. */
function isSimpleRing(r: P[]): boolean {
  const n = r.length;
  if (n < 3 || ringArea(r) <= 0) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (r[i]!.x === r[j]!.x && r[i]!.y === r[j]!.y) return false;
  }
  for (let i = 0; i < n; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segTouch(a, b, r[j]!, r[(j + 1) % n]!)) return false;
    }
  }
  return true;
}
