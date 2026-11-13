/**
 * Capital fracture, slice S1 (docs/architecture/capital-destruction.md).
 *
 * `fractureHull` splits a hull outline into wreck pieces: since v7 a few
 * seeded jagged cracks at the killing blow (a zone either side of it and a
 * fan from it, see `crackLines`), cut through the (possibly concave) hull,
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
 *  the edge.
 *  v4: the primary line ALWAYS runs across the hull (owner review: a bow-tip
 *  hit split the ship lengthwise down the keel). For a bow or stern tip hit
 *  it crosses the hull a seeded 15–35 % of the hull's length aft of that tip,
 *  so the end breaks off as a real piece; one more plan draw (`aftDraw`).
 *  v5 (hostile review of a filmed heavy-cruiser death: cracks over ~60 % of
 *  the hull, a lengthwise "tuning fork" at the bow): the seed density falls
 *  off with the 4th power of the distance from the kill point (was the 2nd,
 *  whose long tail spread cracks down the hull) over a lower floor, and the
 *  Voronoi cells use a metric stretched ALONG the keel
 *  (`VORONOI_KEEL_STRETCH`), so cuts run across a long hull, not along it;
 *  away from the kill point seeds also keep a least keel-wise spacing
 *  (`SEED_ALONG_SEP`), so no bisector runs down the keel to the hull's end.
 *  Lock: `fractureHull.killFocus.test.ts`.
 *  v6 (money-shot review of a filmed death: the far cracks were a comb of
 *  even, evenly spaced square bands and the kill point a zig-zag ladder):
 *  the Voronoi seeds stay inside a FAN of jagged cracks that radiate from
 *  the kill point (`fanLines`, the primary line among them, now jagged too);
 *  the rest of the hull breaks along a few far cracks at seeded, uneven
 *  stations and seeded tilts (`farLines`), so it leaves a few big chunks.
 *  v7 (owner review of a filmed heavy-cruiser death, 2026-11-13: "Tune it";
 *  "The last hit's impact sets the split"; chunks ENORMOUS and heavy): no
 *  Voronoi seeds and no far cracks. The hull breaks only at the kill point:
 *  the primary crack, two jagged ZONE cracks about a beam either side of it
 *  (`ZONE_*`) and up to two cracks from the kill point into the zone
 *  (`zoneFan`), so the impact leaves 2–4 chunky fragments and the rest of
 *  the hull stays as one big section each side. A very heavy blow on a long
 *  hull rarely (`FAR_CHANCE`) adds ONE far crack. The piece count still
 *  rises with size and violence, as more chunks and a wider zone. */
export const FRACTURE_ALGO_VERSION = 7;
/** Default chance that a hull snaps cleanly in two along the primary line
 *  instead of shattering (owner: "just make it a chance"). */
export const FRACTURE_SNAP_CHANCE = 0.2;
/** Output grid: every vertex is a multiple of this. */
export const FRACTURE_QUANTUM = 1 / 64;
/** Hard ceiling on pieces (the S2 wire carries the piece index in a u8). */
export const FRACTURE_MAX_PIECES = 64;

/** v7 zone: each zone crack sits this far (in beams, at the kill point's
 *  edge) from the primary crack: MIN + seeded × SPAN + SIZE × the shatter
 *  amount (0..1, from the target piece count). */
const ZONE_MIN_BEAMS = 0.75;
const ZONE_SPAN_BEAMS = 0.3;
const ZONE_SIZE_BEAMS = 0.15;
/** v7: a zone crack's tilt differs from the primary's by at most this (tan
 *  units), so the zone half never pinches to a sliver across the beam. */
const ZONE_TILT = 0.25;
/** v7: a zone crack leaving less than this (beams) to the hull's end is
 *  dropped (that end joins the zone half instead of breaking off as a chip). */
const ZONE_END_BEAMS = 0.6;
/** v7 fan: a crack from the kill point meets its zone crack this far across
 *  the hull (fraction of the beam): MIN + seeded × SPAN. */
const FAN_DEPTH_MIN = 0.7;
const FAN_DEPTH_SPAN = 0.25;
/** v7: most fan cracks (one per zone half). */
const FAN_MAX = 2;
/** v7: a fan crack is dropped where it would leave a part narrower than
 *  this (beams) or longer than FAN_MAX_ASPECT × its width (filmed take
 *  2026-11-13: a long thin triangle along the hull's edge). */
const FAN_MIN_WIDTH_BEAMS = 0.45;
const FAN_MAX_ASPECT = 2.6;
/** v7 rare far crack: only when the killing blow is at least FAR_MIN_BLOW
 *  of max hull and the hull is at least FAR_MIN_LENGTH_BEAMS long, with this
 *  seeded chance; at most one, FAR_CLEAR_BEAMS past the zone and
 *  FAR_END_CLEAR_BEAMS from the hull's end. */
const FAR_CHANCE = 0.12;
const FAR_MIN_BLOW = 1;
const FAR_MIN_LENGTH_BEAMS = 4.5;
const FAR_CLEAR_BEAMS = 1.2;
const FAR_END_CLEAR_BEAMS = 1.2;
const FAR_TILT = 0.4;
/** Jag sub-segment target length as a fraction of sqrt(hull area). */
const JAG_SEG_FRAC = 0.02;
/** Maximum midpoint-subdivision depth (2^depth segments per cut edge). */
const JAG_MAX_DEPTH = 4;
/** Midpoint displacement amplitude per level, as a fraction of the sub-segment length. */
const JAG_ROUGHNESS = 0.22;
/** v6: passes that straighten one broken jag per piece before giving up on
 *  a piece's jags altogether. */
const JAG_FIX_PASSES = 48;
/** v6: a vertex this many quanta from a cut edge lies on it (T-junction weld). */
const WELD_TOL = 2;

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
/** A primary line through the kill point that leaves less than this fraction
 *  of the hull on one side marks a bow or stern TIP hit. */
const PRIMARY_MIN_SIDE = 0.03;
/** v4: a tip hit's line crosses the hull this far (fraction of the hull's
 *  length along the keel) aft of the tip: MIN + seeded × SPAN. */
const TIP_SECTION_MIN = 0.15;
const TIP_SECTION_SPAN = 0.2;

const EDGE_HULL = 0;
const EDGE_VORONOI = 1;
const EDGE_SECTION = 2;
const EDGE_PRIMARY = 3;
/** v6: a crack of the fan or a far crack (jagged like a Voronoi cut). */
const EDGE_CRACK = 4;
/** Cut edges that get jagged: Voronoi cuts, and since v6 the cracks and the
 *  primary line (cracks, not bulkheads); section cuts stay straight. */
function jagged(k: number): boolean {
  return k === EDGE_VORONOI || k === EDGE_CRACK || k === EDGE_PRIMARY;
}

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
  /** The kill point the fracture uses: the input projected onto the hull
   *  outline (v3). For a side hit the primary line runs through it; for a
   *  bow or stern tip hit the line crosses the hull aft of it (v4). */
  readonly killPoint: Vec2;
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
  const keel = keelAxis(hull);

  // v7 cracks: zone cracks either side of the primary, a fan into the zone
  // and (rarely) one far crack. A clean snap has none.
  const cracks = plan.snap || plan.primary === null
    ? { zone: [] as FractureLine[], fan: [] as LocalLine[], far: [] as FractureLine[] }
    : crackLines(hull, input.seed >>> 0, kill, plan.primary, keel, plan.targetPieces, input.killBlowDamage);

  // Retry without fan cracks (one by one), then the far crack, the section
  // cuts, the zone cracks (one by one) and the primary line, until the cap
  // holds.
  let useCuts = cuts.length > 0;
  let usePrimary = primary !== null;
  let useFar = cracks.far.length > 0;
  let nZone = cracks.zone.length;
  let nFan = cracks.fan.length;
  const minArea = Math.max(4 * FRACTURE_QUANTUM * FRACTURE_QUANTUM, hullArea * 1e-6);
  for (;;) {
    const lines: FractureLine[] = [];
    if (usePrimary) lines.push(primary!);
    for (let i = 0; i < nZone; i++) lines.push(cracks.zone[i]!);
    if (useFar) for (const f of cracks.far) lines.push(f);
    if (useCuts) for (const c of cuts) lines.push(sectionLine(c));
    const rings = splitIntoPieces(hull, lines, cracks.fan, nFan, hullBeam(hull, keel));
    const quantised = quantiseRings(rings, minArea);
    if (quantised.length <= cap) {
      const jagged = jagCutEdges(weldTJunctions(quantised), input.seed >>> 0, scale);
      return jagged.map(toPiece);
    }
    if (nFan > 0) nFan--;
    else if (useFar) useFar = false;
    else if (useCuts) useCuts = false;
    else if (nZone > 0) nZone--;
    else if (usePrimary) usePrimary = false;
    else {
      // Unreachable for a simple hull (no lines = the hull itself).
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
  const aftDraw = rng.u32() / 4294967296; // v4, always drawn (fixed order)

  // Primary line: through the kill point (on the outline, v3), across the
  // keel, tilted by the seed.
  let primary: FracturePlan['primary'] = null;
  const kill = hull.length > 0 ? projectRing(hull, input.killPoint.x, input.killPoint.y) : { x: q(input.killPoint.x), y: q(input.killPoint.y) };
  if (cap >= 2 && hull.length >= 3) {
    const keel = keelAxis(hull);
    const t = (tiltDraw / 1000) * PRIMARY_TILT;
    let dx = -keel.y + keel.x * t;
    let dy = keel.x + keel.y * t;
    const len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
    // A hit near a bow or stern tip: a line through it clips only a sliver.
    // Keep the line ACROSS the hull (never along the keel, v4) and move it a
    // seeded 15–35 % of the hull's length aft of that tip, so the end breaks
    // off as a real piece.
    let point: Vec2 = kill;
    if (minSideFrac(hull, kill, dx, dy) < PRIMARY_MIN_SIDE) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of hull) {
        const a = p.x * keel.x + p.y * keel.y;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
      const kp = kill.x * keel.x + kill.y * keel.y;
      const back = (TIP_SECTION_MIN + TIP_SECTION_SPAN * aftDraw) * (hi - lo);
      const target = kp >= (lo + hi) / 2 ? hi - back : lo + back;
      point = { x: q(kill.x + keel.x * (target - kp)), y: q(kill.y + keel.y * (target - kp)) };
    }
    primary = { point, dir: { x: dx, y: dy } };
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
  return { snap, targetPieces, primary, killPoint: kill };
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

function crackLine(px: number, py: number, t: number, keel: Vec2): FractureLine {
  let dx = -keel.y + keel.x * t;
  let dy = keel.x + keel.y * t;
  const len = Math.sqrt(dx * dx + dy * dy);
  dx /= len;
  dy /= len;
  const nx = -dy;
  const ny = dx;
  return { nx, ny, c: nx * px + ny * py, kind: EDGE_CRACK };
}

/** Inside when `sign · (nx·x + ny·y − c) > 0`. */
interface HalfPlane {
  nx: number;
  ny: number;
  c: number;
  sign: number;
}

/** A crack that splits only the sections whose centroid lies in `region`
 *  (every half-plane holds): a fan crack stays inside its zone half. */
interface LocalLine {
  line: FractureLine;
  region: HalfPlane[];
}

function halfPlane(l: FractureLine, x: number, y: number): HalfPlane {
  return { nx: l.nx, ny: l.ny, c: l.c, sign: l.nx * x + l.ny * y - l.c >= 0 ? 1 : -1 };
}

/**
 * v7: the cracks besides the primary line, from their own seeded stream
 * (every draw is taken, in a fixed order, whatever is used).
 *
 *  - ZONE cracks: one either side of the primary line, about a beam away at
 *    the kill point's edge (`ZONE_*`, wider for a harder death), tilted like
 *    the primary within `ZONE_TILT`. They bound the impact zone; the hull
 *    beyond each stays one big section. A crack that would chip off less
 *    than `ZONE_END_BEAMS` at the hull's end is dropped.
 *  - FAN cracks (local, 0..`FAN_MAX`, more for a harder death): from the
 *    kill point to a seeded depth across its zone crack, so each zone half
 *    breaks into a triangle and a quad, both chunky.
 *  - A FAR crack: one at most, only for a very heavy blow on a long hull,
 *    with a small seeded chance.
 *
 * A tip hit (the primary line moved aft of the tip) has no zone; one fan
 * draw may add a crack across the broken-off end.
 */
function crackLines(
  hull: P[], seed: number, kill: Vec2, primary: NonNullable<FracturePlan['primary']>, keel: Vec2,
  target: number, killBlowDamage: number | undefined,
): { zone: FractureLine[]; fan: LocalLine[]; far: FractureLine[] } {
  const rng = new Rng(fnvMixU32(seed ^ 0xc7ac4, 0x7));
  const f01 = (): number => rng.u32() / 4294967296;
  const dZoneF = f01();
  const dZoneA = f01();
  const dTiltF = f01();
  const dTiltA = f01();
  const dFanN = f01();
  const dFanSide = f01();
  const dDepthF = f01();
  const dDepthA = f01();
  const dFar = f01();
  const dFarStation = f01();
  const dFarTilt = f01();
  const dZoneOrder = f01();

  let lo = Infinity;
  let hi = -Infinity;
  let acLo = Infinity;
  let acHi = -Infinity;
  for (const p of hull) {
    const a = p.x * keel.x + p.y * keel.y;
    const c = p.y * keel.x - p.x * keel.y;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
    if (c < acLo) acLo = c;
    if (c > acHi) acHi = c;
  }
  const beam = acHi - acLo;
  const cMid = (acLo + acHi) / 2;
  const at = (al: number, ac: number): Vec2 => ({ x: keel.x * al - keel.y * ac, y: keel.y * al + keel.x * ac });
  // The primary line's own tilt (its direction is across + t·keel, normalised).
  const pAcross = primary.dir.y * keel.x - primary.dir.x * keel.y;
  const pAlong = primary.dir.x * keel.x + primary.dir.y * keel.y;
  const tP = pAcross !== 0 ? pAlong / pAcross : 0;
  const pl = primaryCut(primary);
  const s = Math.min(1, Math.max(0, (target - MIN_TARGET) / (FRACTURE_MAX_PIECES - MIN_TARGET)));
  const nFan = Math.min(FAN_MAX, Math.floor(2.5 * s + dFanN));

  const zone: FractureLine[] = [];
  const fan: LocalLine[] = [];
  const far: FractureLine[] = [];
  const alK = kill.x * keel.x + kill.y * keel.y;
  const acK = kill.y * keel.x - kill.x * keel.y;

  if (primary.point.x !== kill.x || primary.point.y !== kill.y) {
    // Tip hit: the end beyond the primary line broke off; maybe crack it once.
    const alP = primary.point.x * keel.x + primary.point.y * keel.y;
    const len = Math.abs(alK - alP);
    if (nFan >= 1 && len >= 1.2 * beam) {
      const sg = alK > alP ? 1 : -1;
      const st = alP + sg * (0.4 + 0.2 * dDepthF) * len;
      const c = at(st, cMid);
      fan.push({ line: crackLine(c.x, c.y, tP + (2 * dTiltF - 1) * ZONE_TILT, keel), region: [halfPlane(pl, kill.x, kill.y)] });
    }
    return { zone, fan, far };
  }

  // Inward across the hull from the kill point's edge.
  const sIn = acK <= cMid ? 1 : -1;
  const side = (sg: number, dZ: number, dT: number, dD: number): number => {
    const a = beam * (ZONE_MIN_BEAMS + ZONE_SPAN_BEAMS * dZ + ZONE_SIZE_BEAMS * s);
    const tZ = tP + (2 * dT - 1) * ZONE_TILT;
    // Station of the crack at the kill point's edge and at the far edge.
    const st0 = alK + sg * a;
    const st1 = st0 + tZ * sIn * beam;
    const end = sg > 0 ? hi - Math.max(st0, st1) : Math.min(st0, st1) - lo;
    const c0 = at(st0, acK);
    const zl = end >= ZONE_END_BEAMS * beam ? crackLine(c0.x, c0.y, tZ, keel) : null;
    if (zl) zone.push(zl);
    const want = nFan === 2 || (nFan === 1 && (dFanSide < 0.5) === (sg < 0));
    if (want) {
      // Fan crack: kill point → the zone crack at depth g across the hull.
      const g = (FAN_DEPTH_MIN + FAN_DEPTH_SPAN * dD) * beam;
      const tgt = at(st0 + tZ * sIn * g, acK + sIn * g);
      const tF = (sg * a + tZ * sIn * g) / (sIn * g);
      const region = [halfPlane(pl, tgt.x, tgt.y)];
      if (zl) region.push(halfPlane(zl, kill.x, kill.y));
      fan.push({ line: crackLine(kill.x, kill.y, tF, keel), region });
    }
    return a;
  };
  const aF = side(-1, dZoneF, dTiltF, dDepthF);
  const aA = side(1, dZoneA, dTiltA, dDepthA);
  // Under a tight cap the retry drops the LAST zone crack first: which side
  // keeps its crack is seeded.
  if (dZoneOrder < 0.5) zone.reverse();

  // Rare far crack: one, on the longer side, well clear of the zone.
  if ((killBlowDamage ?? 0) >= FAR_MIN_BLOW && hi - lo >= FAR_MIN_LENGTH_BEAMS * beam && dFar < FAR_CHANCE) {
    const reach = (ZONE_TILT + Math.abs(tP) + FAR_TILT) * beam;
    const roomF = alK - aF - FAR_CLEAR_BEAMS * beam - reach - (lo + FAR_END_CLEAR_BEAMS * beam);
    const roomA = hi - FAR_END_CLEAR_BEAMS * beam - (alK + aA + FAR_CLEAR_BEAMS * beam + reach);
    const room = Math.max(roomF, roomA);
    if (room > 0) {
      const st = roomA >= roomF
        ? alK + aA + FAR_CLEAR_BEAMS * beam + reach + (0.3 + 0.4 * dFarStation) * room
        : lo + FAR_END_CLEAR_BEAMS * beam + (0.3 + 0.4 * dFarStation) * room;
      const c = at(st, cMid);
      far.push(crackLine(c.x, c.y, (2 * dFarTilt - 1) * FAR_TILT, keel));
    }
  }
  return { zone, fan, far };
}

function sectionLine(cut: FractureCut): FractureLine {
  const nx = -(cut.b.y - cut.a.y);
  const ny = cut.b.x - cut.a.x;
  return { nx, ny, c: nx * cut.a.x + ny * cut.a.y, kind: EDGE_SECTION };
}

// ───────────────────────────── pieces ─────────────────────────────

function ringCentroid(r: ReadonlyArray<{ x: number; y: number }>): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q2 = r[(i + 1) % r.length]!;
    const w = p.x * q2.y - q2.x * p.y;
    a += w;
    cx += (p.x + q2.x) * w;
    cy += (p.y + q2.y) * w;
  }
  return a === 0 ? { x: r[0]!.x, y: r[0]!.y } : { x: cx / (3 * a), y: cy / (3 * a) };
}

function splitBoth(sections: P[][], l: FractureLine): P[][] {
  const next: P[][] = [];
  for (const s of sections) {
    for (const part of splitByLine(s, l.nx, l.ny, l.c, l.kind)) next.push(part);
    for (const part of splitByLine(s, -l.nx, -l.ny, -l.c, l.kind)) next.push(part);
  }
  return next;
}

/** Split by every global line, then each of the first `nLocal` local lines
 *  splits only the sections whose centroid lies in its region. */
function splitIntoPieces(hull: P[], lines: ReadonlyArray<FractureLine>, local: ReadonlyArray<LocalLine>, nLocal: number, beam: number): P[][] {
  let sections: P[][] = [hull];
  for (const l of lines) {
    if (l.nx === 0 && l.ny === 0) continue;
    sections = splitBoth(sections, l);
  }
  for (let i = 0; i < nLocal; i++) {
    const { line, region } = local[i]!;
    const next: P[][] = [];
    for (const s of sections) {
      const c = ringCentroid(s);
      let inside = true;
      for (const h of region) if (h.sign * (h.nx * c.x + h.ny * c.y - h.c) <= 0) { inside = false; break; }
      if (!inside) {
        next.push(s);
        continue;
      }
      // v7 (filmed take 2026-11-13: a fan crack left a long thin triangle
      // along the hull's edge): a fan crack that would leave a part narrower
      // than FAN_MIN_WIDTH_BEAMS or longer than FAN_MAX_ASPECT × its width
      // is dropped for this section, which stays whole.
      const parts = splitBoth([s], line);
      let chunky = true;
      for (const part of parts) {
        if (!isChunky(part, beam)) {
          chunky = false;
          break;
        }
      }
      if (chunky) for (const part of parts) next.push(part);
      else next.push(s);
    }
    sections = next;
  }
  return sections;
}

/** Full beam of the hull: its extent across the keel. */
function hullBeam(hull: P[], keel: Vec2): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of hull) {
    const c = p.y * keel.x - p.x * keel.y;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return hi - lo;
}

/** A fan crack's part is chunky when its least width (rotating calipers over
 *  its convex hull's edges) is at least FAN_MIN_WIDTH_BEAMS of the beam and
 *  its length along that edge is at most FAN_MAX_ASPECT × the width.
 *  Arithmetic and sqrt only, fixed order (deterministic). */
function isChunky(ring: ReadonlyArray<{ x: number; y: number }>, beam: number): boolean {
  const ch = convexHullOf(ring);
  if (ch.length < 3) return false;
  let bestW = Infinity;
  let bestL = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = ch[i]!;
    const b = ch[(i + 1) % ch.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.sqrt(ex * ex + ey * ey);
    if (el <= 0) continue;
    let w = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of ch) {
      const d = Math.abs(ex * (v.y - a.y) - ey * (v.x - a.x)) / el;
      if (d > w) w = d;
      const t = (ex * (v.x - a.x) + ey * (v.y - a.y)) / el;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (w < bestW) {
      bestW = w;
      bestL = hi - lo;
    }
  }
  return bestW >= FAN_MIN_WIDTH_BEAMS * beam && bestL <= FAN_MAX_ASPECT * bestW;
}

/** Convex hull (Andrew's monotone chain), CCW, collinear points dropped. */
function convexHullOf(ring: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const pts = ring.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
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

/**
 * v6: weld T-junctions on cut edges. A crack between a big piece and a wedge
 * that Voronoi cells split again is ONE edge on the big piece and several on
 * the wedge side, so no sub-edge was shared by exactly two pieces and the
 * crack stayed straight. Every vertex of another ring lying on a cut edge
 * (within `WELD_TOL` quanta: the vertices are already on the grid) is
 * inserted into it, so both sides list the same sub-edges. Deterministic:
 * rings and vertices in a fixed order, insertions sorted along the edge.
 */
function weldTJunctions(rings: P[][]): P[][] {
  const tol = WELD_TOL * FRACTURE_QUANTUM;
  const box: Array<[number, number, number, number]> = rings.map((r) => ringBox(r));
  const out: P[][] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri]!;
    const [rx0, ry0, rx1, ry1] = box[ri]!;
    const res: P[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      res.push(a);
      if (a.k === EDGE_HULL) continue;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const l2 = ex * ex + ey * ey;
      if (l2 === 0) continue;
      const len = Math.sqrt(l2);
      const ins: Array<{ t: number; x: number; y: number }> = [];
      for (let rj = 0; rj < rings.length; rj++) {
        if (rj === ri) continue;
        const [sx0, sy0, sx1, sy1] = box[rj]!;
        if (sx1 < rx0 - tol || sx0 > rx1 + tol || sy1 < ry0 - tol || sy0 > ry1 + tol) continue;
        for (const v of rings[rj]!) {
          if ((v.x === a.x && v.y === a.y) || (v.x === b.x && v.y === b.y)) continue;
          const t = ((v.x - a.x) * ex + (v.y - a.y) * ey) / l2;
          if (t <= 0 || t >= 1) continue;
          const d = Math.abs((v.x - a.x) * ey - (v.y - a.y) * ex) / len;
          if (d > tol) continue;
          let dup = false;
          for (const p of ins) if (p.x === v.x && p.y === v.y) { dup = true; break; }
          if (!dup) ins.push({ t, x: v.x, y: v.y });
        }
      }
      ins.sort((p, q) => p.t - q.t || p.x - q.x || p.y - q.y);
      for (const p of ins) res.push({ x: p.x, y: p.y, k: a.k });
    }
    out.push(stripSpikes(dedupe(res)));
  }
  return out;
}

function jagCutEdges(rings: P[][], seed: number, scale: number): P[][] {
  // Count each Voronoi cut edge; only edges shared by exactly two pieces are
  // jagged, so both neighbours always draw the same line.
  const count = new Map<string, number>();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (!jagged(r[i]!.k)) continue;
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
      if (!jagged(a.k)) continue;
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
      if (forward) for (let m = 0; m < pts.length; m++) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: a.k });
      else for (let m = pts.length - 1; m >= 0; m--) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: a.k });
    }
    return { ring: stripSpikes(dedupe(out)), keys };
  };
  // Straighten (globally, so both sides agree) any jag that breaks a piece.
  // v6: one edge at a time (the one with the most jag points first), so a
  // thin wedge doesn't straighten every crack around it; after
  // `JAG_FIX_PASSES` passes, every jag of a still-broken piece goes.
  for (let pass = 0; pass < 2 * JAG_FIX_PASSES; pass++) {
    let changed = false;
    for (const r of rings) {
      const { ring, keys } = build(r);
      if (keys.length > 0 && !isSimpleRing(ring)) {
        if (pass < JAG_FIX_PASSES) {
          let best = keys[0]!;
          for (const k of keys) if ((cache.get(k)?.length ?? 0) > (cache.get(best)?.length ?? 0)) best = k;
          straight.add(best);
        } else for (const k of keys) straight.add(k);
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
