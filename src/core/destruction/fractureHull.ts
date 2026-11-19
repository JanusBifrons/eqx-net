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
import { Rng, fnvMixU32 } from '../random/rng.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import { ANGLE_STEPS, unitDirFromSteps } from '../geometry/unitDir.js';
import {
  applyExtraCuts, cutStrip, ringArea, splitBoth, type FractureLine, type P,
} from './fractureSplit.js';
import {
  EDGE_CUT, EDGE_PRIMARY, EDGE_SECTION, FRACTURE_QUANTUM, allAtLeast, normaliseHull, q, quantiseRings, toPiece,
} from './fractureRings.js';
import { jagCutEdges, weldTJunctions } from './fractureJag.js';
import {
  FAN_MIN_WIDTH_BEAMS, FAN_MAX_ASPECT, allChunky, hullBeam, isChunky, keelAxis, minSideFrac, projectRing, ringCentroid,
} from './fractureMeasure.js';
import {
  SPLINTER_MAX, SPLINTER_MIN_WIDTH_BEAMS, crackLine, crackLines, cutSplinters, damageResponse, extraCrack, primaryCut,
  type LocalLine,
} from './fractureCracks.js';
import {
  FRACTURE_MAX_PIECES, MIN_TARGET, type FractureCut, type FractureInput, type FracturePiece, type FracturePlan,
} from './fractureTypes.js';

// Moved verbatim to the siblings (fractureTypes.ts: the input/output types
// and piece limits; fractureRings.ts: grid, edge kinds, ring helpers, piece
// output; fractureJag.ts: jagged cut edges; fractureMeasure.ts: keel, beam,
// centroid, projection, chunky guard; fractureCracks.ts: the crack lines);
// re-exported so importers keep using this module.
export { EDGE_CUT, EDGE_HULL, FRACTURE_QUANTUM } from './fractureRings.js';
export {
  FRACTURE_MAX_PIECES, type FractureCut, type FractureEdgeKind, type FractureExtraCut, type FractureInput,
  type FractureKillCut, type FracturePiece, type FracturePlan,
} from './fractureTypes.js';

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
 *  rises with size and violence, as more chunks and a wider zone.
 *  v8 (take 9 review, 2026-11-14): the `soundMinShare` option; the
 *  sub-capital profile sets 0.33, so its sound primary crack leaves no piece
 *  over ~70 % of the hull. Capital output is unchanged (default 0.15).
 *  v9 kill cuts (`cut`: a straight slice line, a railgun channel strip);
 *  v10 capital splinters off the cut and the heavy beam's wide slice; v11
 *  `cutBurnMinShare`: a cut kill burns away pieces too small (none left =
 *  vaporised); v12 multi-cut (`extraCuts`: every other beam that burned the
 *  hull in the last moment cuts its own straight line too, owner
 *  2026-11-15 "one cut per beam"); v13 burned gap (a wide slice runs through
 *  the kill point as given). Each is byte-identical without a cut (v12:
 *  without `extraCuts`; v13: without a wide slice); detail and history in
 *  capital-destruction.md "Kill cuts", "Burned gap" and its version trail. */
export const FRACTURE_ALGO_VERSION = 13;
/** v12: most `extraCuts` a fracture applies (more are ignored): with the
 *  main cut, four beams' lines at most. */
export const FRACTURE_MAX_EXTRA_CUTS = 3;
/** Default chance that a hull snaps cleanly in two along the primary line
 *  instead of shattering (owner: "just make it a chance"). */
export const FRACTURE_SNAP_CHANCE = 0.2;

/** Maximum midpoint-subdivision depth (2^depth segments per cut edge). */
const JAG_MAX_DEPTH = 4;
/** Midpoint displacement amplitude per level, as a fraction of the sub-segment length. */
const JAG_ROUGHNESS = 0.22;

/** Largest tilt of the primary line off square-across-the-keel, as the
 *  keel-wise component of its (unnormalised) direction: 0.35 ≈ 19°. */
const PRIMARY_TILT = 0.35;
/** Hull radius at which the size factor saturates (a battleship is ~2900 u). */
const SIZE_FULL_RADIUS = 3000;
/** How far the seeded draw can move the shatter amount either way. */
const COUNT_SPREAD = 0.5;
/** A primary line through the kill point that leaves less than this fraction
 *  of the hull on one side marks a bow or stern TIP hit. */
const PRIMARY_MIN_SIDE = 0.03;
/** v4: a tip hit's line crosses the hull this far (fraction of the hull's
 *  length along the keel) aft of the tip: MIN + seeded × SPAN. */
const TIP_SECTION_MIN = 0.15;
const TIP_SECTION_SPAN = 0.2;
/** Sub-capital sound primary (`chunkyPieces`): each of the two pieces holds
 *  at least this share of the hull, else the line moves toward the centroid
 *  by these fractions of the way (0 = through the kill point). */
const SOUND_MIN_SHARE = 0.15;
const SOUND_SHIFTS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

/** v9: a slice that would leave a piece under the profile minimum slides
 *  toward the hull's centroid in this many equal steps (the line keeps the
 *  shot's direction). */
const CUT_SLIDE_STEPS = 16;
/** v9: a part a channel leaves under this share of the hull is a sliver
 *  and is erased with the channel (any profile). */
const CHANNEL_SLIVER_SHARE = 0.05;
/** v10: a capital cut kill's cracks jag this hard (`JAG_ROUGHNESS` is 0.22),
 *  so a splinter reads as torn metal at capital zoom beside the dead-straight
 *  cut (film review 2026-11-15: the v9 cracks read as straight lines). */
const SPLINTER_ROUGHNESS = 0.4;

/** A kill cut's direction travels as a u16 angle (`CUT_ANGLE_STEPS` per
 *  turn, the wreck descriptor's `cutAng`). */
export const CUT_ANGLE_STEPS = ANGLE_STEPS;

/**
 * The unit direction of a u16 cut angle (`cutAng`: angle × 65536 / 2π, in
 * the hull's 1× Pixi-up frame, x then y). Both sides turn the descriptor's
 * angle into the fracture's `cut` direction with this; it is the shared
 * arithmetic-only `unitDirFromSteps` (never sin/cos).
 */
export function cutDirFromAngle(ang: number): Vec2 {
  return unitDirFromSteps(ang);
}

export function fractureHull(input: FractureInput): FracturePiece[] {
  const hull = normaliseHull(input.hull);
  if (hull.length < 3) return [];
  const plan = planFor(input, hull);
  const cutKind = plan.cut === null ? null : plan.cut.kind;
  // A channel, or (v10) a slice with a width (the heavy beam): a strip
  // erased between two straight cuts at +-width/2.
  const strip = plan.cut !== null && (plan.cut.kind === 'channel' || plan.cut.width > 0) && input.sweepCuts !== true;
  const cap = plan.snap ? clampCap(input.maxPieces) : plan.targetPieces;
  const hullArea = ringArea(hull);
  const scale = Math.sqrt(hullArea);
  const cuts = plan.snap ? [] : (input.sectionCuts ?? []);
  const kill = projectRing(hull, input.killPoint.x, input.killPoint.y);
  const keel = keelAxis(hull);
  const chunkyOnly = input.chunkyPieces === true;
  const minArea = Math.max(4 * FRACTURE_QUANTUM * FRACTURE_QUANTUM, hullArea * 1e-6);
  const beam = hullBeam(hull, keel);
  const chunkyWidth = input.chunkyMinWidthBeams ?? FAN_MIN_WIDTH_BEAMS;
  const jagDepth = input.jag?.depth ?? JAG_MAX_DEPTH;
  // v10: a capital cut kill's splinters jag harder (the cut stays straight).
  const splinterKill = cutKind !== null && !chunkyOnly;
  const jagRoughness = splinterKill ? SPLINTER_ROUGHNESS : (input.jag?.roughness ?? JAG_ROUGHNESS);
  // `sweepCuts` (rocks): the cut moves like a sound crack, unburned.
  const sweep = chunkyOnly && cutKind !== null && input.sweepCuts === true;
  const primary = plan.primary
    ? (cutKind === null || sweep) && chunkyOnly
      ? soundPrimary(hull, plan.primary, keel, hullArea, minArea, beam, chunkyWidth, input.soundMinShare ?? SOUND_MIN_SHARE, sweep ? EDGE_CUT : EDGE_PRIMARY)
      : primaryCut(plan.primary, cutKind !== null ? EDGE_CUT : EDGE_PRIMARY)
    : null;
  // v9 channel: the strip either side of the cut line is erased first; the
  // other cracks then split what is left. A sliver beside the channel
  // (`CHANNEL_SLIVER_SHARE`) is erased with it.
  const burnShare = cutKind !== null && input.cutBurnMinShare !== undefined && input.cutBurnMinShare > 0 ? input.cutBurnMinShare : 0;
  const burnMin = burnShare * hullArea;
  const stripMinPart = (burnShare > 0 ? burnShare : CHANNEL_SLIVER_SHARE) * hullArea;
  let start: P[][] = [hull];
  if (strip && primary !== null) start = cutStrip(start, primary.nx, primary.ny, primary.c, plan.cut!.width / 2, stripMinPart, EDGE_CUT);
  // v12 multi-cut: each further beam's line splits every part it crosses (a
  // wide one erases its strip like the main cut). They are fixed in `start`,
  // so the cap's retry loop never drops one.
  if (primary !== null && cutKind !== null && input.extraCuts !== undefined) {
    start = applyExtraCuts(start, input.extraCuts, FRACTURE_MAX_EXTRA_CUTS, stripMinPart, EDGE_CUT);
  }

  // v7 cracks: zone cracks either side of the primary, a fan into the zone
  // and (rarely) one far crack. A clean snap has none. With a v9 cut they
  // are laid out from the line the hull would have cracked along without
  // it (`crackPrimary`), so they are the same cracks.
  const drawn = plan.snap || plan.crackPrimary === null
    ? { zone: [] as FractureLine[], fan: [] as LocalLine[], far: [] as FractureLine[] }
    : crackLines(hull, input.seed >>> 0, kill, plan.crackPrimary, keel, plan.targetPieces, input.killBlowDamage);
  // Profile options (sub-capitals): drop whole crack families after the
  // draws, so the seeded stream is the same whatever is used.
  const cracks: { zone: FractureLine[]; fan: LocalLine[]; far: FractureLine[] } = {
    zone: !chunkyOnly
      ? drawn.zone
      : plan.snap || primary === null
        ? []
        : extraCrack(
          hull, input.seed >>> 0, cutKind !== null ? primaryCut(plan.crackPrimary!) : primary, keel,
          input.extraChunkChance ?? 0, input.killBlowDamage, input.recentDamageRate,
        ),
    fan: input.fanCracks === false ? [] : drawn.fan,
    far: input.farCrack === false ? [] : drawn.far,
  };
  // v10: a capital cut kill splinters off the cut instead: as many cracks as
  // the un-cut layout drew (the violence table's count), branching off the
  // cut line, none parallel to it (film review 2026-11-15).
  if (splinterKill && primary !== null) {
    const n = Math.min(SPLINTER_MAX, cracks.zone.length + cracks.fan.length + cracks.far.length);
    cracks.fan = n > 0 ? cutSplinters(hull, input.seed >>> 0, plan.primary!, keel, n) : [];
    cracks.zone = [];
    cracks.far = [];
  }

  // Retry without fan cracks (one by one), then the far crack, the section
  // cuts, the zone cracks (one by one) and the primary line, until the cap
  // holds.
  let useCuts = cuts.length > 0;
  let usePrimary = primary !== null;
  let useFar = cracks.far.length > 0;
  let nZone = cracks.zone.length;
  let nFan = cracks.fan.length;
  for (;;) {
    const lines: FractureLine[] = [];
    if (usePrimary && !strip) lines.push(primary!);
    for (let i = 0; i < nZone; i++) lines.push(cracks.zone[i]!);
    if (useFar) for (const f of cracks.far) lines.push(f);
    if (useCuts) for (const c of cuts) lines.push(sectionLine(c));
    const rings = splitIntoPieces(start, lines, cracks.fan, nFan, beam);
    const quantised = quantiseRings(rings, minArea);
    const onlyPrimary = nFan === 0 && !useFar && !useCuts && nZone === 0;
    // v9: a kill cut is never dropped: with every other crack gone it stands
    // whatever the count (a slice across a concave hull may cut three).
    const cutStands = cutKind !== null && usePrimary && onlyPrimary;
    // v11: a crack never leaves a piece the cut would burn (only the cut burns).
    if (
      (quantised.length <= cap || cutStands)
      && (!chunkyOnly || onlyPrimary || allChunky(quantised, beam, chunkyWidth))
      && (burnShare === 0 || onlyPrimary || allAtLeast(quantised, burnMin))
    ) {
      const jagged = jagCutEdges(
        weldTJunctions(quantised), input.seed >>> 0, scale, jagDepth, jagRoughness, splinterKill ? JAG_ROUGHNESS : undefined,
      );
      if (burnShare === 0) return jagged.map(toPiece);
      // v11: what is left too small burns away, after the jag. None: vaporised.
      const out: FracturePiece[] = [];
      for (const r of jagged) if (ringArea(r) >= burnMin) out.push(toPiece(r));
      return out;
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
  const { snap, targetPieces, primary, killPoint } = planFor(input, normaliseHull(input.hull));
  return { snap, targetPieces, primary, killPoint };
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

/** The plan plus what only `fractureHull` reads: the v9 cut (null without
 *  one, with a zero direction or with no primary line) and the line the
 *  secondary cracks are laid out from (the plan's primary without a cut;
 *  with one, the line the hull would have cracked along without it). */
interface InternalPlan extends FracturePlan {
  readonly cut: { readonly kind: 'slice' | 'channel'; readonly width: number } | null;
  readonly crackPrimary: FracturePlan['primary'];
}

/** The least share of the hull one piece of a v9 slice may hold: the sound
 *  primary's share for a chunky (sub-capital) profile, else the tip-hit
 *  share. */
function cutMinShare(input: FractureInput): number {
  return input.chunkyPieces === true ? (input.soundMinShare ?? SOUND_MIN_SHARE) : PRIMARY_MIN_SIDE;
}

function planFor(input: FractureInput, hull: P[]): InternalPlan {
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

  // v9 kill cut: the primary line runs along the shot through the kill point
  // (no tilt, no tip shift). No draw is added or skipped, so a fracture
  // without a cut is unchanged.
  const crackPrimary = primary;
  let cut: InternalPlan['cut'] = null;
  const ic = input.cut;
  if (primary !== null && ic !== undefined) {
    const cl = Math.sqrt(ic.dirX * ic.dirX + ic.dirY * ic.dirY);
    if (cl > 0) {
      const dir = { x: ic.dirX / cl, y: ic.dirY / cl };
      cut = { kind: ic.kind, width: ic.width > 0 ? ic.width : 0 };
      // v13 burned gap: a wide slice runs down the beam's axis (the kill point as given).
      const point = ic.kind !== 'slice' ? kill
        : cut.width > 0 ? { x: q(input.killPoint.x), y: q(input.killPoint.y) }
        : slicePoint(hull, kill, dir, cutMinShare(input));
      primary = { point, dir };
    }
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
  return { snap, targetPieces, primary, killPoint: kill, cut, crackPrimary };
}

/**
 * v9 slice: the point the slice line (along unit `dir`) runs through. The
 * kill point, unless the line there leaves a piece under `minShare` of the
 * hull (a shot along the hull's edge): then the line slides toward the
 * centroid in `CUT_SLIDE_STEPS` steps, keeping its direction, until every
 * piece clears; failing that it runs through the centroid. Arithmetic only.
 */
function slicePoint(hull: P[], kill: Vec2, dir: Vec2, minShare: number): Vec2 {
  const total = ringArea(hull);
  if (total <= 0) return kill;
  const nx = -dir.y;
  const ny = dir.x;
  const cen = ringCentroid(hull);
  const minArea = Math.max(4 * FRACTURE_QUANTUM * FRACTURE_QUANTUM, total * 1e-6);
  for (let i = 0; i <= CUT_SLIDE_STEPS; i++) {
    const f = i / CUT_SLIDE_STEPS;
    const p = i === 0 ? kill : { x: q(kill.x + (cen.x - kill.x) * f), y: q(kill.y + (cen.y - kill.y) * f) };
    const parts = quantiseRings(splitBoth([hull], { nx, ny, c: nx * p.x + ny * p.y, kind: EDGE_CUT }), minArea);
    if (parts.length < 2) continue;
    let ok = true;
    for (const r of parts) {
      if (ringArea(r) < minShare * total) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return { x: q(cen.x), y: q(cen.y) };
}

/**
 * Sub-capital primary crack (`chunkyPieces`): the plan's line, kept only when
 * it splits the hull into exactly two pieces of at least `SOUND_MIN_SHARE`
 * each. A line across a small concave hull clips wingtips and tail fins off
 * as slivers (or cuts four pieces, which the cap then drops whole), so the
 * line moves toward the centroid in `SOUND_SHIFTS` steps, same direction;
 * the last resort is square across the keel through the centroid. A swept
 * cut (EDGE_CUT) also tries square across, so a strip breaks across.
 */
function soundPrimary(
  hull: P[], p: NonNullable<FracturePlan['primary']>, keel: Vec2, hullArea: number, minArea: number,
  beam: number, minWidthBeams: number, minShare: number, kind = EDGE_PRIMARY,
): FractureLine {
  const base = primaryCut(p, kind);
  const cen = ringCentroid(hull);
  const sound = (l: FractureLine, strict: boolean): boolean => {
    const parts = quantiseRings(splitBoth([hull], l), minArea);
    if (parts.length !== 2) return false;
    for (const r of parts) {
      if (ringArea(r) < minShare * hullArea) return false;
      if (strict && !isChunky(r, beam, minWidthBeams)) return false;
    }
    return true;
  };
  // First pass: both pieces chunky too; second: area only (a hull whose
  // halves can't both be chunky, e.g. a long thin one).
  for (let pass = 0; pass < 2; pass++) {
    for (const f of SOUND_SHIFTS) {
      const x = p.point.x + (cen.x - p.point.x) * f;
      const y = p.point.y + (cen.y - p.point.y) * f;
      const l: FractureLine = { nx: base.nx, ny: base.ny, c: base.nx * x + base.ny * y, kind };
      if (sound(l, pass === 0)) return l;
    }
    if (pass === 0) {
      // A swept delta wing: every cut across the keel leaves a wide thin
      // tail strip. Try the diagonals, then down the keel, through the
      // centroid (a fighter is not a capital: v4's "never along the keel"
      // was about a 5 km hull).
      const ax = -keel.y;
      const ay = keel.x;
      const dirs = [ax + keel.x, ay + keel.y, ax - keel.x, ay - keel.y, keel.x, keel.y];
      if (kind === EDGE_CUT) dirs.push(ax, ay);
      for (let i = 0; i < dirs.length; i += 2) {
        const nx = -dirs[i + 1]!;
        const ny = dirs[i]!;
        const l: FractureLine = { nx, ny, c: nx * cen.x + ny * cen.y, kind };
        if (sound(l, true)) return l;
      }
    }
  }
  const sq = crackLine(cen.x, cen.y, 0, keel);
  return { nx: sq.nx, ny: sq.ny, c: sq.c, kind };
}

function sectionLine(cut: FractureCut): FractureLine {
  const nx = -(cut.b.y - cut.a.y);
  const ny = cut.b.x - cut.a.x;
  return { nx, ny, c: nx * cut.a.x + ny * cut.a.y, kind: EDGE_SECTION };
}

// ───────────────────────────── pieces ─────────────────────────────

/** Split `start` (the hull, or what a v9 channel left of it) by every
 *  global line, then each of the first `nLocal` local lines splits only the
 *  sections whose centroid lies in its region. */
function splitIntoPieces(start: P[][], lines: ReadonlyArray<FractureLine>, local: ReadonlyArray<LocalLine>, nLocal: number, beam: number): P[][] {
  let sections: P[][] = start;
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
      const big = local[i]!.splinter === true ? 0.5 * ringArea(s) : Infinity;
      let chunky = true;
      for (const part of parts) {
        if (!isChunky(part, beam, big < Infinity ? SPLINTER_MIN_WIDTH_BEAMS : FAN_MIN_WIDTH_BEAMS, ringArea(part) >= big ? Infinity : FAN_MAX_ASPECT)) {
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

