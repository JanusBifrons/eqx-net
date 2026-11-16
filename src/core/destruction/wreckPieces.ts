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
 *    for `WRECK_CRACK_MS`. Then the server adds each piece's `kick`
 *    (`wreckBreakKicks`: impulses against the piece's own mass, so a big
 *    piece parts subtly and a sliver faster, a slow seeded spin, and the
 *    least impulses that keep every shared cut opening; owner reviews
 *    2026-11-13 / 2026-11-15: heavy, and neighbours never overlap or hinge).
 *
 * Runs once per death (not hot-loop code); allocates freely.
 */
import { projectToOutline, FRACTURE_SNAP_CHANCE } from './fractureHull.js';
import { findSeams } from './wreckSeams.js';
export { findSeams, type Seam } from './wreckSeams.js';
import { gapLine, partGap } from './wreckBurnedGap.js';
import { hullCutAngleOf } from './burnLines.js';
import type { WreckExtraCut } from '../../shared-types/messages/wreckDescriptor.js';
import { fracturePiecesToGeometry, wreckRootFracture } from './wreckPieceFrame.js';
import type { WreckFractureInputs, WreckPieceGeometry } from './wreckPieceFrame.js';
export type { WreckFractureInputs, WreckPieceGeometry } from './wreckPieceFrame.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { Rng, fnvMixU32 } from '../random/rng.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import { SUBCAP_WRECK_COLLISION_GROUPS, WRECK_COLLISION_GROUPS } from '../physics/collisionGroups.js';
import { asWreckSource, wreckSourceOf, type WreckSource } from './wreckSource.js';

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
/** Room-wide cap on live SUB-CAPITAL wreck pieces (sub-capital break-up slice
 *  2). A separate FIFO from the capitals' (`MAX_LIVE_WRECK_PIECES`), so
 *  fighter debris never evicts a capital wreck piece. Owner 2026-11-13: "For
 *  now scrap is permanent ... let's start big and see what happens": settled
 *  pieces sleep in the physics engine, so this is a generous budget guard,
 *  not a lifetime. Slice 5 sizes it from a soak. Slot pool: `MAX_ENTITIES`
 *  (5120) = this + the 768 capital pieces + drones, rocks, structures, scrap. */
export const MAX_LIVE_SUBCAP_WRECK_PIECES = 2000;

/** How a wreck piece's physics body is built, from its parent kind's
 *  destruction profile: collision groups (`piecesCollide`) and damping
 *  (`dampingScale`). The ONE source for the server body (`SwarmSpawner
 *  .spawnWreck`) and the client predWorld twin (`WreckClientLeaf`), #15.
 *  A capital's is exactly the S2 values (byte-identical). */
export interface WreckBodyParams {
  collisionGroups: number;
  linearDamping: number;
  angularDamping: number;
  /** Settle-to-sleep thresholds (`World.setSleepSettle`): u/s from the
   *  profile's `settlePerRadius` × the kind's radius (#18), rad/s from its
   *  `settleSpin`. 0 = off (capitals). */
  settleSpeed: number;
  settleSpin: number;
}

const wreckBodyParamsCache = new Map<string, WreckBodyParams>();

/** The body parameters of a wreck piece of `kindId` (cached per kind: read
 *  at spawn, never allocates after the first call), or of a rock's piece
 *  (its source: by its radius, computed per call at spawn). */
export function wreckBodyParams(source: ShipKindId | WreckSource): WreckBodyParams {
  if (typeof source !== 'string') return bodyParamsOf(source.profile, source.radius);
  const kindId = source;
  let p = wreckBodyParamsCache.get(kindId);
  if (p === undefined) {
    const kind = getShipKind(kindId);
    p = bodyParamsOf(DESTRUCTION_PROFILES[shipTuning(kind).destruction], kind.radius);
    wreckBodyParamsCache.set(kindId, p);
  }
  return p;
}

function bodyParamsOf(prof: WreckSource['profile'], radius: number): WreckBodyParams {
  return {
    collisionGroups: prof.piecesCollide ? WRECK_COLLISION_GROUPS : SUBCAP_WRECK_COLLISION_GROUPS,
    linearDamping: WRECK_LINEAR_DAMPING * prof.dampingScale,
    angularDamping: WRECK_ANGULAR_DAMPING * prof.dampingScale,
    settleSpeed: prof.settlePerRadius * radius,
    settleSpin: prof.settleSpin,
  };
}

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
  /** v9 kill cut, copied into the fracture inputs as they are (absent = the
   *  normal break-up; see `WreckFractureInputs`). */
  cutKind?: 'slice' | 'channel';
  cutAng?: number;
  cutW?: number;
  /** v12 multi-cut: the other cutting beams' lines (`BurnLines.extraCuts`),
   *  copied into the fracture inputs as they are (only with a cut). */
  extraCuts?: ReadonlyArray<WreckExtraCut>;
}

export interface WreckPieceSpec {
  index: number;
  /** Centroid in the ship's scaled math-up frame (the geometry's `cx`,
   *  `cy`): where the hull's frame sits under the piece. */
  cx: number;
  cy: number;
  x: number;
  y: number;
  /** Spawn velocity: the dead hull's rigid motion at this point (v + ω × r),
   *  ω scaled by the profile's `spinScale`. */
  vx: number;
  vy: number;
  angle: number;
  /** Spawn spin: the dead hull's ω × the profile's `spinScale`. */
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

export interface WreckBuild {
  pieces: WreckPieceSpec[];
  /** The inputs the pieces were fractured from (the S2b descriptor). */
  fracture: WreckFractureInputs;
  /** The kill point in the hull's 1× Pixi-up frame, on the outline (the
   *  S2b descriptor's killX/killY, except a v13 burned gap's: there the
   *  descriptor carries the hit point as it is, on the beam's axis). */
  killLocal: Vec2;
  /** The kill point in world space (on the hull). */
  killWorldOnHull: Vec2;
}

/** World point → the hull's 1× Pixi-up frame, projected onto the outline. */
export function hullLocalKillPoint(kindId: ShipKindId, pose: WreckDeathPose, world: Vec2): Vec2 {
  return projectToOutline(shipHullOutline(getShipKind(kindId)), hullLocalPoint(kindId, pose, world));
}

/** World point → the hull's 1× Pixi-up frame, as it is (not projected). */
function hullLocalPoint(kindId: ShipKindId, pose: WreckDeathPose, world: Vec2): Vec2 {
  const s = shipShapeScale(getShipKind(kindId));
  const c = Math.cos(pose.angle);
  const sn = Math.sin(pose.angle);
  const dx = world.x - pose.x;
  const dy = world.y - pose.y;
  const mx = dx * c + dy * sn;
  const my = -dx * sn + dy * c;
  return { x: mx / s, y: -my / s };
}

/** A world direction → the u16 cut angle in the hull's 1× Pixi-up frame
 *  (`WreckFractureInputs.cutAng`). Server side, once per death: only the
 *  integer it returns reaches the fracture, so its trig never has to agree
 *  across engines. */
export function hullLocalCutAngle(pose: WreckDeathPose, dirWorld: Vec2): number {
  return hullCutAngleOf(pose.angle, dirWorld.x, dirWorld.y);
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
  // The raw fracture and its body-frame geometry live in wreckPieceFrame.ts,
  // shared with the child fracture (`wreckChildGeometry`).
  return fracturePiecesToGeometry(wreckSourceOf(input), wreckRootFracture(input));
}

/**
 * The break-up kicks of pieces `geom` of one `kindId` hull (dv, dω per piece,
 * in the ship's scaled math-up frame), for a break at (kx, ky) in that frame.
 * The ONE break-up kick model: the first break-up (`buildWreckPieces`) and a
 * worn-out piece's re-split (`planWreckResplit`) both call it.
 *
 * Every linear kick is an impulse against the piece's real mass (its share
 * of `shipBodyMass`, the mass its body gets), like the overkill knock (owner
 * 2026-11-15: "the scrap/wreck should weigh A LOT ... an accurate mass value
 * vs the forces applied"), so a heavy piece parts subtly and a sliver faster:
 *  - the blast: an impulse away from the break point of hull mass ×
 *    `wreckPushMin/Max` (falling off with distance, × `harder`) × √(the
 *    piece's mass share). The impulse grows with the piece's size (√area),
 *    its mass with its area, so dv = push ÷ √share;
 *  - the crack: an equal and opposite impulse along each shared cut's
 *    normal of hull mass × `wreckCrack` × (cut length ÷ hull radius), the
 *    force acting on the cut faces;
 *  - the guard: the least impulses (mass-weighted, momentum kept) that make
 *    every cut open at `wreckSeparate` × the profile's `separateScale` or
 *    more along all of it (spin included), so no seam hinges, slides shut or
 *    overlaps (owner review 2026-11-13). Gauss–Seidel over the seams; a
 *    uniform expansion satisfies every seam at once, so the passes converge.
 * The spin is a slow seeded rim speed (`wreckSeparate` × the rim fractions,
 * so a big piece turns slower) × the profile's `spinScale`.
 * `cutGap`: a channel's (or a wide slice's) width, scaled frame (its two
 * banks part like a shared cut). `slice`: a wide slice's line (a point in
 * the scaled math-up frame, the u16 hull-frame cut angle): with a `cutGap`,
 * the guard also makes every bank point of the strip move straight away
 * from the line at the profile's `cutPartSpeed` or more, spin included
 * (`partGap`; fracture v13 burned gap). Once per break (allocates).
 */
export function wreckBreakKicks(
  source: ShipKindId | WreckSource, geom: ReadonlyArray<WreckPieceGeometry>, kx: number, ky: number,
  harder: number, spinSeed: number, cutGap: number, slice?: { px: number; py: number; ang: number },
): { kvx: Float64Array; kvy: Float64Array; kw: Float64Array } {
  // A ship's numbers or a rock's (wreckSource.ts), same model.
  const src = asWreckSource(source);
  const kind = src;
  const tuning = { wreckPushMin: src.pushMin, wreckPushMax: src.pushMax, wreckSeparate: src.separate, wreckCrack: src.crack };
  const prof = src.profile;
  const hullMass = Math.max(1e-3, src.bodyMass);
  const pushFar = tuning.wreckPushMin * harder * prof.pushScale;
  const pushExtra = (tuning.wreckPushMax - tuning.wreckPushMin) * harder * prof.pushScale;
  const rf = WRECK_PUSH_FALLOFF_FRAC * kind.radius;
  const rf2 = rf * rf;
  const spinRng = new Rng(spinSeed >>> 0);
  const spinMinR = WRECK_SPIN_MIN_RADIUS_FRAC * kind.radius;
  const n = geom.length;
  const kvx = new Float64Array(n);
  const kvy = new Float64Array(n);
  const kw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = geom[i]!;
    let ox = g.cx - kx;
    let oy = g.cy - ky;
    const ol2 = ox * ox + oy * oy;
    const ol = Math.sqrt(ol2);
    const near = rf2 / (rf2 + ol2); // 1 at the break point → 0 far away
    // Impulse hullMass × push × √share over mass share × hullMass.
    const push = (pushFar + pushExtra * near) / Math.sqrt(Math.min(1, g.mass / hullMass));
    if (ol > 1e-6) {
      ox /= ol;
      oy /= ol;
    } else {
      ox = 0;
      oy = 0;
    }
    kvx[i] = ox * push;
    kvy[i] = oy * push;
    // Spin: a slow rim speed, fastest near the break point, seeded size
    // (0.55–1×) and direction; a bigger piece turns slower.
    const u = spinRng.u32() / 4294967296;
    const rim = tuning.wreckSeparate * (WRECK_SPIN_RIM_FAR + (WRECK_SPIN_RIM_NEAR - WRECK_SPIN_RIM_FAR) * near) * (0.55 + 0.9 * Math.abs(u - 0.5));
    const mag = (rim / Math.max(g.radius, spinMinR)) * prof.spinScale;
    kw[i] = u < 0.5 ? -mag : mag;
  }

  const seams = findSeams(geom, cutGap);
  // The crack: each shared cut throws its two faces apart.
  const crackPerLength = (hullMass * tuning.wreckCrack * prof.crackScale) / kind.radius;
  for (const sm of seams) {
    const len = Math.sqrt((sm.bx - sm.ax) ** 2 + (sm.by - sm.ay) ** 2);
    const imp = crackPerLength * len;
    const wi = 1 / geom[sm.i]!.mass;
    const wj = 1 / geom[sm.j]!.mass;
    kvx[sm.i] = kvx[sm.i]! - sm.nx * imp * wi;
    kvy[sm.i] = kvy[sm.i]! - sm.ny * imp * wi;
    kvx[sm.j] = kvx[sm.j]! + sm.nx * imp * wj;
    kvy[sm.j] = kvy[sm.j]! + sm.ny * imp * wj;
  }

  // The guard. The push is fastest at the break point, so a piece nearer it
  // chases the slower neighbour beyond it along the same line, and the spins
  // turn long pieces into each other (owner review 2026-11-13: pieces "slide
  // over each other", a "V" hinge at a stern seam).
  const sep = tuning.wreckSeparate * prof.separateScale;
  // Fracture v13 burned gap: its banks part too, in the same passes.
  const gap = slice !== undefined && cutGap > 0 && prof.cutPartSpeed > 0 ? gapLine(geom, slice, cutGap, prof.cutPartSpeed) : null;
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
    if (gap !== null) worst = Math.max(worst, partGap(gap, geom, kvx, kvy, kw, SEPARATE_AIM));
    if (worst === 0) break;
  }
  return { kvx, kvy, kw };
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
  // v13 burned gap: a wide slice's line runs through the beam's own axis, so
  // the descriptor carries the hit point as it is (the beam's axis at its
  // first contact, which a wide beam makes with its edge, off the outline).
  // Projecting it onto the outline would slide the strip off the beam.
  const burnedGap = input.cutKind === 'slice' && input.cutAng !== undefined && input.cutW !== undefined && input.cutW > 0
    && input.killWorld !== null;
  const cutPoint = burnedGap ? hullLocalPoint(input.kindId, pose, target) : killLocal;

  const fracture: WreckFractureInputs = {
    kindId: input.kindId,
    seed: input.seed >>> 0,
    killX: cutPoint.x,
    killY: cutPoint.y,
    killBlowDamage: input.killBlowDamage,
    recentDamageRate: input.recentDamageRate,
    snapChance: DESTRUCTION_PROFILES[shipTuning(kind).destruction].fracture?.snapChance ?? FRACTURE_SNAP_CHANCE,
  };
  // Only a cut kill carries the cut fields (an un-cut wreck's inputs keep
  // their old shape).
  if (input.cutKind !== undefined && input.cutAng !== undefined) {
    fracture.cutKind = input.cutKind;
    fracture.cutAng = input.cutAng;
    if (input.cutW !== undefined) fracture.cutW = input.cutW;
    if (input.extraCuts !== undefined && input.extraCuts.length > 0) fracture.extraCuts = input.extraCuts;
  }
  const geom = wreckPieceGeometry(fracture);

  // The parting kicks: impulses against each piece's own mass
  // (`wreckBreakKicks`), harder for a more violent death.
  const harder = 0.75 + 0.5 * violence(input.killBlowDamage, input.recentDamageRate);
  // The profile's spin scale also takes the dying hull's ω the pieces inherit.
  const hullW = pose.angvel * DESTRUCTION_PROFILES[shipTuning(kind).destruction].spinScale;
  const n = geom.length;
  const { kvx, kvy, kw } = wreckBreakKicks(
    input.kindId, geom, killLocal.x * s, -killLocal.y * s, harder,
    fnvMixU32((input.seed >>> 0) ^ 0x3ec7, 0x5),
    fracture.cutKind !== undefined ? (fracture.cutW ?? 0) * s : 0,
    burnedGap ? { px: cutPoint.x * s, py: -cutPoint.y * s, ang: input.cutAng! } : undefined,
  );

  const pieces: WreckPieceSpec[] = [];
  for (let i = 0; i < n; i++) {
    const g = geom[i]!;
    // Centroid: the ship's scaled math-up frame → rotate → world.
    const centre = { x: pose.x + g.cx * c - g.cy * sn, y: pose.y + g.cx * sn + g.cy * c };
    const rx = centre.x - pose.x;
    const ry = centre.y - pose.y;
    pieces.push({
      index: g.index,
      cx: g.cx,
      cy: g.cy,
      x: centre.x,
      y: centre.y,
      vx: pose.vx - hullW * ry,
      vy: pose.vy + hullW * rx,
      angle: pose.angle,
      angvel: hullW,
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
