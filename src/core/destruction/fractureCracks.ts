/**
 * The crack lines of fractureHull.ts besides the section cuts: the primary
 * line, the v7 zone / fan / far cracks (`crackLines`), the sub-capital extra
 * chunk (`extraCrack`) and the v10 cut-kill splinters (`cutSplinters`), each
 * from its own seeded stream, plus the damage response they share with the
 * plan. Pure and deterministic under the rules in fractureHull.ts.
 */
import { Rng, fnvMixU32 } from '../random/rng.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import type { FractureLine, P } from './fractureSplit.js';
import { EDGE_CRACK, EDGE_PRIMARY } from './fractureRings.js';
import { ringCentroid } from './fractureMeasure.js';
import { FRACTURE_MAX_PIECES, MIN_TARGET, type FracturePlan } from './fractureTypes.js';

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
/** Half-saturation of the damage inputs: f(x) = x / (x + DAMAGE_KNEE). */
const DAMAGE_KNEE = 0.35;
/** v10 splinters (a capital cut kill's secondary cracks, `cutSplinters`):
 *  at most this many (two a side), at a seeded slope off the cut between
 *  SPLINTER_SLOPE_MIN and +SPAN (tan 40 deg..tan 58 deg), the first on a side
 *  rooted so it reaches the hull's edge SPLINTER_REACH_MIN..+SPAN of the
 *  cut's chord along the cut from its root, the second branching off the
 *  first SPLINTER_BRANCH_MIN..+SPAN of the way along it. */
export const SPLINTER_MAX = 4;
/** v10: a splinter is dropped where it would leave a part narrower than
 *  this (beams; a fan crack: `FAN_MIN_WIDTH_BEAMS`). */
export const SPLINTER_MIN_WIDTH_BEAMS = 0.3;
const SPLINTER_SLOPE_MIN = 0.839;
const SPLINTER_SLOPE_SPAN = 0.761;
/** v10: a splinter never runs within ~30 deg of the keel (cos 30 deg). */
const SPLINTER_KEEL_COS = 0.866;
const SPLINTER_REACH_MIN = 0.55;
const SPLINTER_REACH_SPAN = 0.2;
const SPLINTER_BRANCH_MIN = 0.2;
const SPLINTER_BRANCH_SPAN = 0.2;

/** Saturating 0..1 response to a 0..1+ damage input. */
export function damageResponse(x: number | undefined): number {
  const v = x !== undefined && x > 0 ? x : 0;
  return v / (v + DAMAGE_KNEE);
}

export function primaryCut(p: NonNullable<FracturePlan['primary']>, kind = EDGE_PRIMARY): FractureLine {
  const nx = -p.dir.y;
  const ny = p.dir.x;
  return { nx, ny, c: nx * p.point.x + ny * p.point.y, kind };
}

/** Radial cracks fan this far either side of the kill point's inward line,
 *  as tan(θ/2) (θ ≈ ±65°), so none runs along the struck face. */
const RADIAL_HALF_SPREAD = 0.64;
/** Seeded jitter of each radial crack within its slot (a share of it). */
const RADIAL_JITTER = 0.6;

/**
 * Radial cracks (`radialCracks`, structures): `n` straight cracks through
 * the kill point, spread evenly (seeded jitter) either side of the line from
 * it to the hull's centroid, so a squarish hull shatters into n + 1 wedges
 * from the hit. Directions by the rational half-angle form (no trig, #15).
 * Its own seeded stream.
 */
export function radialCracks(hull: P[], seed: number, kill: Vec2, n: number): FractureLine[] {
  const out: FractureLine[] = [];
  if (n <= 0) return out;
  const cen = ringCentroid(hull);
  let vx = cen.x - kill.x;
  let vy = cen.y - kill.y;
  const vl = Math.sqrt(vx * vx + vy * vy);
  if (vl < 1e-9) return out;
  vx /= vl;
  vy /= vl;
  const rng = new Rng(fnvMixU32(seed ^ 0x7ad1a, 0xb));
  // Centre-out order (j = middle, then alternating out), so dropping the
  // last line first (the cap / sliver loop) drops the outermost wedge.
  for (let q = 0; q < n; q++) {
    const lo = (n - 1) >> 1; // the middle line (the lower middle for even n)
    const j = n % 2 === 1
      ? (q % 2 === 0 ? lo - q / 2 : lo + (q + 1) / 2)
      : (q % 2 === 0 ? lo - q / 2 : lo + 1 + (q - 1) / 2);
    const jit = (rng.u32() / 4294967296 - 0.5) * RADIAL_JITTER;
    const s = RADIAL_HALF_SPREAD * (-1 + (2 * (j + 0.5 + jit)) / n);
    const k = 1 / (1 + s * s);
    const ca = (1 - s * s) * k;
    const sa = 2 * s * k;
    // v rotated by θ: (cos θ, sin θ) = ((1 − s²), 2s) / (1 + s²).
    const dx = vx * ca - vy * sa;
    const dy = vx * sa + vy * ca;
    const nx = -dy;
    const ny = dx;
    out.push({ nx, ny, c: nx * kill.x + ny * kill.y, kind: EDGE_CRACK });
  }
  return out;
}

/**
 * Sub-capital extra chunk (`chunkyPieces`): with a seeded chance (rising
 * with violence) one crack across the keel on the LONGER side of the primary
 * crack, a seeded 35–65 % of the way to that end, tilted within `ZONE_TILT`.
 * Its own seeded stream; the chunky guard drops it where it would leave a
 * thin piece (so a stubby fighter mostly just snaps in two).
 */
export function extraCrack(
  hull: P[], seed: number, primary: FractureLine, keel: Vec2, chance: number,
  killBlowDamage: number | undefined, recentDamageRate: number | undefined,
): FractureLine[] {
  const rng = new Rng(fnvMixU32(seed ^ 0x5bca9, 0x9));
  const dWant = rng.u32() / 4294967296;
  const dStation = rng.u32() / 4294967296;
  const dTilt = rng.u32() / 4294967296;
  const violence = 0.5 * damageResponse(killBlowDamage) + 0.5 * damageResponse(recentDamageRate);
  if (dWant >= chance + (1 - chance) * 0.5 * violence) return [];
  const cen = ringCentroid(hull);
  // The primary's station along the keel: where it crosses the keel line
  // through the centroid (the line is roughly across the keel).
  const kn = primary.nx * keel.x + primary.ny * keel.y;
  if (kn === 0) return [];
  const alC = cen.x * keel.x + cen.y * keel.y;
  const alP = alC + (primary.c - (primary.nx * cen.x + primary.ny * cen.y)) / kn;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of hull) {
    const a = p.x * keel.x + p.y * keel.y;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  const st = hi - alP >= alP - lo ? alP + (0.35 + 0.3 * dStation) * (hi - alP) : alP - (0.35 + 0.3 * dStation) * (alP - lo);
  const acC = cen.y * keel.x - cen.x * keel.y;
  const at = { x: keel.x * st - keel.y * acC, y: keel.y * st + keel.x * acC };
  return [crackLine(at.x, at.y, (2 * dTilt - 1) * ZONE_TILT, keel)];
}

export function crackLine(px: number, py: number, t: number, keel: Vec2): FractureLine {
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
export interface HalfPlane {
  nx: number;
  ny: number;
  c: number;
  sign: number;
}

/** A crack that splits only the sections whose centroid lies in `region`
 *  (every half-plane holds): a fan crack stays inside its zone half. */
export interface LocalLine {
  line: FractureLine;
  region: HalfPlane[];
  /** v10 splinter: the chunky guard skips the length check on a part that
   *  keeps at least half the section (a cut kill's big end section is long
   *  by nature; only a thin chip or a long thin wedge is refused). */
  splinter?: boolean;
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
export function crackLines(
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

/**
 * v10: a capital cut kill's secondary cracks, SPLINTERS off the cut (film
 * review 2026-11-15: v9's zone cracks ran parallel to the cut, full beam,
 * and one shot read as three cuts). Its own seeded stream; every draw is
 * taken, in a fixed order, whatever `n` is.
 *
 * Splinter i runs into side `sides[i % 2]` of the cut line only (a local
 * line whose region is that side), leaning along the cut at a seeded slope
 * (40-58 deg off it). The first on a side starts ON the cut, placed so it
 * meets the hull's edge a seeded 55-75 % of the cut's chord along the cut
 * from its root: a big chunk breaks out of the cut's corner. The second on a
 * side branches off the first, part-way along it, leaning the other way,
 * into what the first left (region: beyond the first's line). Neither runs
 * the hull's full width, and the fan's chunky guard drops one where it would
 * leave a thin part, like a fan crack. Arithmetic and sqrt only.
 */
export function cutSplinters(hull: P[], seed: number, cut: NonNullable<FracturePlan['primary']>, keel: Vec2, n: number): LocalLine[] {
  const rng = new Rng(fnvMixU32(seed ^ 0x5b11e, 0xa));
  const f01 = (): number => rng.u32() / 4294967296;
  const dSide = f01();
  const draws: Array<[number, number, number]> = [];
  for (let i = 0; i < SPLINTER_MAX; i++) draws.push([f01(), f01(), f01()]);
  const d = cut.dir;
  const nx = -d.y;
  const ny = d.x;
  const o = cut.point;
  const cl = primaryCut(cut);
  // The cut's chord: where its line enters and leaves the hull (along d from o).
  let t0 = Infinity;
  let t1 = -Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const da = (a.x - o.x) * nx + (a.y - o.y) * ny;
    const db = (b.x - o.x) * nx + (b.y - o.y) * ny;
    if ((da < 0) === (db < 0)) continue;
    const s = da / (da - db);
    const t = (a.x + (b.x - a.x) * s - o.x) * d.x + (a.y + (b.y - a.y) * s - o.y) * d.y;
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  if (!(t1 > t0)) return [];
  const chord = t1 - t0;
  const sides = dSide < 0.5 ? [1, -1] : [-1, 1];
  const out: LocalLine[] = [];
  const first: Array<{ root: Vec2; dir: Vec2; lean: number; len: number }> = [];
  for (let i = 0; i < n; i++) {
    const [dA, dB, dC] = draws[i]!;
    const sg = sides[i % 2]!;
    const side = halfPlane(cl, o.x + sg * nx, o.y + sg * ny);
    const k = SPLINTER_SLOPE_MIN + SPLINTER_SLOPE_SPAN * dB;
    if (i < 2) {
      // On the cut, leaning toward one end, reaching the edge 55-75 % of the
      // chord from its root.
      // Never down the keel (a quartering cut): then it leans the other way.
      let lean = dC < 0.5 ? 1 : -1;
      if (alongKeel(unit(lean * d.x + k * sg * nx, lean * d.y + k * sg * ny), keel)) lean = -lean;
      const reach = (SPLINTER_REACH_MIN + SPLINTER_REACH_SPAN * dA) * chord;
      const tr = lean > 0 ? t1 - reach : t0 + reach;
      const root = { x: o.x + d.x * tr, y: o.y + d.y * tr };
      const u = unit(lean * d.x + k * sg * nx, lean * d.y + k * sg * ny);
      // Its length to the hull's edge, about: `reach` along the cut.
      first.push({ root, dir: u, lean, len: reach * Math.sqrt(1 + k * k) });
      out.push({ line: localCrack(root, u), region: [side], splinter: true });
    } else {
      // Branch off the same side's first splinter, leaning back the other way.
      const f = first[i - 2]!;
      const at = (SPLINTER_BRANCH_MIN + SPLINTER_BRANCH_SPAN * dA) * f.len;
      const p = { x: f.root.x + f.dir.x * at, y: f.root.y + f.dir.y * at };
      const u = unit(-f.lean * d.x + k * sg * nx, -f.lean * d.y + k * sg * ny);
      // A branch that would run down the keel is left out.
      if (alongKeel(u, keel)) continue;
      // Beyond the first splinter: the side of its line away from its lean.
      const beyond = halfPlane(
        localCrack(f.root, f.dir), f.root.x - f.lean * d.x * 0.1 * chord, f.root.y - f.lean * d.y * 0.1 * chord,
      );
      out.push({ line: localCrack(p, u), region: [side, beyond], splinter: true });
    }
  }
  return out;
}

/** v10: a splinter within SPLINTER_KEEL_COS of the keel would run down
 *  the hull's length (the v4 rule: cracks run across a long hull). */
function alongKeel(u: Vec2, keel: Vec2): boolean {
  return Math.abs(u.x * keel.x + u.y * keel.y) > SPLINTER_KEEL_COS;
}

function unit(x: number, y: number): Vec2 {
  const l = Math.sqrt(x * x + y * y);
  return { x: x / l, y: y / l };
}

/** A crack line through `p` along the unit `u`. */
function localCrack(p: Vec2, u: Vec2): FractureLine {
  const nx = -u.y;
  const ny = u.x;
  return { nx, ny, c: nx * p.x + ny * p.y, kind: EDGE_CRACK };
}
