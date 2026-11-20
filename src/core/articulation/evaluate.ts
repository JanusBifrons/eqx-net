/**
 * Deterministic rig evaluation (structure-restyle 2a, plan §5).
 *
 * `evaluateRig(rig, playing, nowTick, out, ik?)` is a pure function of its
 * inputs: the server only sends `{clipId, startTick, target?}` and every
 * client reproduces the pose. It writes each part's joint value and its pose
 * relative to the host (forward kinematics through the parent chain) into a
 * caller-owned `RigPose` sized at build time. It allocates nothing
 * (invariant #14).
 *
 * Rules:
 *  - no clip record (`playing` null): the rig's idle pose, its `idleClip`'s
 *    held end pose (every part at rest when it has none);
 *  - an unknown clip id, or `nowTick < startTick`: every part at rest;
 *  - a part without a track in the clip stays at rest;
 *  - a track's first key after tick 0 eases from rest at tick 0;
 *  - after a track's last key it holds that key;
 *  - every value is clamped to its joint limits;
 *  - a lift joint moves nothing in the plane (only `value` changes).
 *
 * Targeted clips: keys marked `fromTarget` take their value from an injected
 * IK solver (`IkSolve`; the real 2-bone one is `twoBoneIkSolve` in `ikAdapter.ts`). With no target or no
 * solver those keys fall back to rest. On a hinge, the IK value takes the
 * whole-turn copy nearest the key it blends from, within the joint limits
 * (`nearestTurn`), so the blend goes the short way round.
 *
 * Tip paths (`IkChainDef.tipPath`): in a segment between two keys where one
 * is `fromTarget`, the chain is solved for the eased point on the straight
 * line between the two keys' tips, on the fold the target's solve took, so
 * the clamp travels straight at (or back from) its target and stops at rest
 * on it. The ease is timed in JOINT travel, not tip distance (`retimeTipPath`):
 * near the chain root a little tip travel turns the joints a lot, so an evenly
 * eased tip whipped the crane boom where the line leaves its folded pose. A `foldMirror` waypoint key flips to `-value` when that fold is
 * not the clip's `bend`, so the segment starts in place on either fold.
 */
import { applyEase } from './easing.js';
import { JOINT_HINGE, JOINT_LIFT, JOINT_SLIDE, liftProgress, type CompiledClip, type Rig } from './rig.js';

/** A clip playing on a rig: the whole wire record (2e). */
export interface PlayingClip {
  readonly clipId: string;
  /** Game tick the clip started on. */
  readonly startTick: number;
  /** Target point in the HOST frame, for a targeted clip. */
  readonly target?: { readonly x: number; readonly y: number };
  /** 3e: a holding clip's length in ticks (the pose ignores it; the cargo
   *  carried along the arm is timed from it, `craneCargo.ts`). */
  readonly holdTicks?: number;
  /** 3e: which way that cargo moves (`CRANE_CARGO_*`); absent = none. */
  readonly cargo?: number;
}

/** What an IK solver is asked (one reused object per pose, no allocation). */
export interface IkRequest {
  rig: Rig;
  /** Chain part indices root -> tip (rig order). */
  chain: Int16Array;
  /** Frame the chain root's anchor sits in, relative to the host: the chain
   *  root's parent pose (or the host origin for a host-fixed root). */
  originX: number;
  originY: number;
  originAngle: number;
  /** End effector in the tip part's frame. */
  tipX: number;
  tipY: number;
  /** Fold direction of a 2-bone chain (+1 counter-clockwise, -1 clockwise). */
  bend: 1 | -1;
  /** Swing side in the host frame ((0, 0) = keep `bend`): the solver takes
   *  the fold whose middle joint lies further along it (`IkChainDef.swingSide`). */
  sideX: number;
  sideY: number;
  /** Target in the host frame. */
  targetX: number;
  targetY: number;
  /** Written by the solver: the fold it took (`evaluateRig` presets `bend`). */
  fold: 1 | -1;
}

/**
 * The IK hook: write one joint value per chain part into `out[0..chain.length)`
 * (limits are applied by the caller). Must be pure and allocation-free.
 * Returns false when the target is out of reach (still writing a best effort).
 */
export type IkSolve = (req: IkRequest, out: Float64Array) => boolean;

/** Caller-owned evaluation scratch for one rig. */
export interface RigPose {
  /** Joint value per part (rad for a hinge, world units for a slide). */
  readonly value: Float64Array;
  /** Part frame origin relative to the host. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Part frame angle relative to the host (rad). */
  readonly angle: Float64Array;
  /** cos / sin of `angle`, cached for children and the mount bridge. */
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  /** IK scratch. */
  readonly ikOut: Float64Array;
  /** Tip-path scratch: chain values at the segment's start, its end, and now. */
  readonly pathA: Float64Array;
  readonly pathB: Float64Array;
  readonly pathOut: Float64Array;
  /** Tip-path retiming scratch (`retimeTipPath`): the previous sample's chain
   *  values, the cumulative joint travel at each of the TIP_PATH_SAMPLES + 1
   *  points of the line, and the segment that table is for (a cache key). */
  readonly pathPrev: Float64Array;
  readonly pathCum: Float64Array;
  pathKeyClip: CompiledClip | null;
  pathKeyK: number;
  pathKeyFold: number;
  pathKeyAx: number;
  pathKeyAy: number;
  pathKeyBx: number;
  pathKeyBy: number;
  readonly ikReq: IkRequest;
  /** Last IK verdict for the playing clip (true when none was asked). */
  ikReached: boolean;
}

/** Points along a tip path at which its joint travel is tabled (`retimeTipPath`). */
const TIP_PATH_SAMPLES = 32;

/** Pre-size the evaluation scratch for `rig` (build time). */
export function createRigPose(rig: Rig): RigPose {
  const n = rig.partCount;
  return {
    value: new Float64Array(n), x: new Float64Array(n), y: new Float64Array(n),
    angle: new Float64Array(n), cos: new Float64Array(n), sin: new Float64Array(n),
    ikOut: new Float64Array(rig.maxChain),
    pathA: new Float64Array(rig.maxChain), pathB: new Float64Array(rig.maxChain), pathOut: new Float64Array(rig.maxChain),
    pathPrev: new Float64Array(rig.maxChain), pathCum: new Float64Array(TIP_PATH_SAMPLES + 1),
    pathKeyClip: null, pathKeyK: -1, pathKeyFold: 0, pathKeyAx: NaN, pathKeyAy: NaN, pathKeyBx: NaN, pathKeyBy: NaN,
    ikReq: {
      rig, chain: new Int16Array(0), originX: 0, originY: 0, originAngle: 0,
      tipX: 0, tipY: 0, bend: 1, sideX: 0, sideY: 0, targetX: 0, targetY: 0, fold: 1,
    },
    ikReached: true,
  };
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const TWO_PI = 2 * Math.PI;

/**
 * A hinge angle from IK, turned by whole turns to the copy NEAREST `from`
 * (the key it blends from) that lies within [lo, hi]; unchanged when no
 * other copy fits. IK answers in [-π, π], but a hinge whose limits span
 * more than [-π, π] can hold the same pose at two values, and the
 * linear blend between keys must go the short way round, inside the limits
 * (a crane jib allowed to fold over its boom, [0, 2π], swings over the
 * boom to reach the other side rather than unfolding straight out through
 * 0). Arithmetic only, no allocation.
 */
function nearestTurn(v: number, from: number, lo: number, hi: number): number {
  let best = v;
  let bestD = v >= lo && v <= hi ? Math.abs(v - from) : Infinity;
  for (let k = -1; k <= 1; k += 2) {
    const c = v + k * TWO_PI;
    if (c < lo || c > hi) continue;
    const d = Math.abs(c - from);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Evaluate one track at clip-local time `t` (>= 0). */
function sampleTrack(
  ticks: Float64Array, values: Float64Array, ease: Uint8Array, fromTarget: Uint8Array, mirror: Uint8Array,
  restValue: number, ikValue: number, useIk: boolean, flip: boolean, t: number,
  hinge: boolean, lo: number, hi: number,
): number {
  const m = ticks.length;
  let prevTick = 0;
  let prevVal = restValue;
  for (let k = 0; k < m; k++) {
    const kt = ticks[k]!;
    const kv = fromTarget[k] === 1 && useIk ? (hinge ? nearestTurn(ikValue, prevVal, lo, hi) : ikValue)
      : mirror[k] === 1 && flip ? (hinge ? nearestTurn(-values[k]!, prevVal, lo, hi) : -values[k]!)
        : values[k]!;
    if (t < kt) {
      const span = kt - prevTick;
      const f = applyEase(ease[k]!, (t - prevTick) / span);
      return prevVal + (kv - prevVal) * f;
    }
    prevTick = kt;
    prevVal = kv;
  }
  return prevVal;
}

/** Sample chain slot `s`'s track of `clip` at clip time `t` (IK on). */
function sampleChain(rig: Rig, clip: CompiledClip, s: number, ikOut: Float64Array, flip: boolean, t: number): number {
  const pi = clip.chain[s]!;
  const tr = clip.tracks[clip.trackOfPart[pi]!]!;
  return sampleTrack(tr.ticks, tr.values, tr.ease, tr.fromTarget, tr.mirror, rig.rest[pi]!,
    ikOut[s]!, true, flip, t, true, rig.min[pi]!, rig.max[pi]!);
}

let fkX = 0;
let fkY = 0;
/** Forward kinematics of the chain in `req` at hinge values `v` (per chain
 *  slot): the tip, host frame, into `fkX` / `fkY`. */
function chainTip(req: IkRequest, v: Float64Array): void {
  const rig = req.rig, chain = req.chain;
  let x = req.originX, y = req.originY, a = req.originAngle;
  for (let s = 0; s < chain.length; s++) {
    const pi = chain[s]!;
    const c = Math.cos(a), sn = Math.sin(a);
    const ax = rig.anchorX[pi]!, ay = rig.anchorY[pi]!;
    x += ax * c - ay * sn;
    y += ax * sn + ay * c;
    a += rig.baseAngle[pi]! + v[s]!;
  }
  const c = Math.cos(a), sn = Math.sin(a);
  fkX = x + req.tipX * c - req.tipY * sn;
  fkY = y + req.tipX * sn + req.tipY * c;
}

/**
 * Tip path (`IkChainDef.tipPath`): when clip time `t` is inside a segment
 * with a `fromTarget` end, solve the chain for the eased point between the
 * two ends' tips on fold `fold` into `out.pathOut` (each value the turn
 * nearest the segment's start, within the limits). Returns false outside
 * such a segment (the tracks blend as usual).
 */
function solveTipPath(rig: Rig, clip: CompiledClip, t: number, flip: boolean, fold: 1 | -1, out: RigPose, ik: IkSolve): boolean {
  const root = clip.tracks[clip.trackOfPart[clip.chain[0]!]!]!;
  const ticks = root.ticks;
  let k = 0;
  while (k < ticks.length && !(t < ticks[k]!)) k++;
  if (k >= ticks.length) return false;
  const ft = root.fromTarget;
  if (ft[k] !== 1 && !(k > 0 && ft[k - 1] === 1)) return false;
  const t0 = k > 0 ? ticks[k - 1]! : 0;
  const t1 = ticks[k]!;
  const { pathA, pathB, pathOut, ikOut } = out;
  const n = clip.chain.length;
  for (let s = 0; s < n; s++) {
    pathA[s] = sampleChain(rig, clip, s, ikOut, flip, t0);
    pathB[s] = sampleChain(rig, clip, s, ikOut, flip, t1);
  }
  const req = out.ikReq;
  chainTip(req, pathA);
  const ax = fkX, ay = fkY;
  chainTip(req, pathB);
  const bx = fkX, by = fkY;
  req.bend = fold;
  req.sideX = 0;
  req.sideY = 0;
  if (out.pathKeyClip !== clip || out.pathKeyK !== k || out.pathKeyFold !== fold
    || out.pathKeyAx !== ax || out.pathKeyAy !== ay || out.pathKeyBx !== bx || out.pathKeyBy !== by) {
    retimeTipPath(rig, clip, ax, ay, bx, by, out, ik);
    out.pathKeyClip = clip; out.pathKeyK = k; out.pathKeyFold = fold;
    out.pathKeyAx = ax; out.pathKeyAy = ay; out.pathKeyBx = bx; out.pathKeyBy = by;
  }
  const f = tipFraction(out.pathCum, applyEase(root.ease[k]!, (t - t0) / (t1 - t0)));
  req.targetX = ax + (bx - ax) * f;
  req.targetY = ay + (by - ay) * f;
  ik(req, pathOut);
  for (let s = 0; s < n; s++) {
    const pi = clip.chain[s]!;
    pathOut[s] = nearestTurn(pathOut[s]!, pathA[s]!, rig.min[pi]!, rig.max[pi]!);
  }
  return true;
}

/**
 * Table the joint travel along the tip line A -> B (`req` set up for the
 * segment's fold): `pathCum[i]` is the travel from A to the i-th of
 * TIP_PATH_SAMPLES even steps, each step's travel the LARGEST change of any
 * chain joint (so no joint outruns the eased travel). Starts from `pathA`.
 */
function retimeTipPath(rig: Rig, clip: CompiledClip, ax: number, ay: number, bx: number, by: number, out: RigPose, ik: IkSolve): void {
  const { pathA, pathOut, pathPrev, pathCum, ikReq: req } = out;
  const n = clip.chain.length;
  for (let s = 0; s < n; s++) pathPrev[s] = pathA[s]!;
  pathCum[0] = 0;
  for (let i = 1; i <= TIP_PATH_SAMPLES; i++) {
    const g = i / TIP_PATH_SAMPLES;
    req.targetX = ax + (bx - ax) * g;
    req.targetY = ay + (by - ay) * g;
    ik(req, pathOut);
    let d = 0;
    for (let s = 0; s < n; s++) {
      const pi = clip.chain[s]!;
      const v = nearestTurn(pathOut[s]!, pathPrev[s]!, rig.min[pi]!, rig.max[pi]!);
      const dv = Math.abs(v - pathPrev[s]!);
      if (dv > d) d = dv;
      pathPrev[s] = v;
    }
    pathCum[i] = pathCum[i - 1]! + d;
  }
}

/** The fraction of the tip line at which the joints have done eased share
 *  `e` of their travel (`pathCum`, piecewise linear); `e` itself when
 *  the joints do not move. */
function tipFraction(pathCum: Float64Array, e: number): number {
  const total = pathCum[TIP_PATH_SAMPLES]!;
  if (!(total > 0)) return e;
  const u = e * total;
  let i = 0;
  while (i < TIP_PATH_SAMPLES - 1 && pathCum[i + 1]! < u) i++;
  const lo = pathCum[i]!, span = pathCum[i + 1]! - lo;
  const w = span > 0 ? (u - lo) / span : 0;
  return (i + (w < 0 ? 0 : w > 1 ? 1 : w)) / TIP_PATH_SAMPLES;
}

/** An aiming hinge's value (`PartDef.aim`): `d`, the aim direction measured
 *  from the joint's zero, wrapped to [-π, π). Arithmetic only. */
export function aimHinge(d: number): number {
  const TAU = 2 * Math.PI;
  return d - TAU * Math.floor((d + Math.PI) / TAU);
}

/**
 * Pose the rig at `nowTick` (game ticks; fractional ticks are allowed for
 * render interpolation). Writes `out`; returns `out`. `aim` (a host-frame
 * direction, rad; client look only) turns every aiming part (`PartDef.aim`)
 * to face it, clamped to its limits; undefined (the server) poses them like
 * any part.
 */
export function evaluateRig(
  rig: Rig, playing: PlayingClip | null, nowTick: number, out: RigPose, ik?: IkSolve, aim?: number,
): RigPose {
  const n = rig.partCount;
  let clipIdx = -1;
  let t = 0;
  if (playing !== null) {
    t = nowTick - playing.startTick;
    if (t >= 0) {
      const cs = rig.clips;
      for (let i = 0; i < cs.length; i++) if (cs[i]!.id === playing.clipId) { clipIdx = i; break; }
    }
  } else if (rig.idleClip >= 0) {
    clipIdx = rig.idleClip;
    t = rig.clips[clipIdx]!.endTick;
  }
  const clip = clipIdx >= 0 ? rig.clips[clipIdx]! : null;
  const target = playing !== null ? playing.target : undefined;
  const wantIk = clip !== null && clip.chain.length > 0 && target !== undefined && ik !== undefined;
  const chainRoot = wantIk ? clip.chain[0]! : -1;
  let ikDone = false;
  let flip = false;
  let onPath = false;
  out.ikReached = true;

  const { parent, jointType, anchorX, anchorY, baseAngle, axisX, axisY, min, max, rest } = rig;
  const { value, x, y, angle, cos, sin, ikOut } = out;
  for (let i = 0; i < n; i++) {
    const p = parent[i]!;
    const pX = p < 0 ? 0 : x[p]!;
    const pY = p < 0 ? 0 : y[p]!;
    const pA = p < 0 ? 0 : angle[p]!;
    const pC = p < 0 ? 1 : cos[p]!;
    const pS = p < 0 ? 0 : sin[p]!;

    // IK runs once, when the chain root is reached: its parent frame is final.
    if (i === chainRoot && !ikDone) {
      const req = out.ikReq;
      req.rig = rig;
      req.chain = clip!.chain;
      req.originX = pX; req.originY = pY; req.originAngle = pA;
      req.tipX = clip!.tipX; req.tipY = clip!.tipY; req.bend = clip!.bend;
      req.sideX = clip!.sideX; req.sideY = clip!.sideY;
      req.targetX = target!.x; req.targetY = target!.y;
      req.fold = req.bend;
      out.ikReached = ik!(req, ikOut);
      ikDone = true;
      const fold = req.fold;
      flip = fold !== clip!.bend;
      if (clip!.tipPath) onPath = solveTipPath(rig, clip!, t, flip, fold, out, ik!);
    }

    // Joint value.
    let v = rest[i]!;
    if (clip !== null) {
      const ti = clip.trackOfPart[i]!;
      if (ti >= 0) {
        const tr = clip.tracks[ti]!;
        const useIk = ikDone && tr.chainSlot >= 0;
        v = onPath && tr.chainSlot >= 0 ? out.pathOut[tr.chainSlot]!
          : sampleTrack(tr.ticks, tr.values, tr.ease, tr.fromTarget, tr.mirror, rest[i]!,
            useIk ? ikOut[tr.chainSlot]! : 0, useIk, useIk && flip, t, jointType[i] === JOINT_HINGE, min[i]!, max[i]!);
      }
    }
    if (aim !== undefined && rig.aims[i] === 1) v = aimHinge(aim - pA - baseAngle[i]!);
    v = clampTo(v, min[i]!, max[i]!);
    value[i] = v;

    // Forward kinematics: anchor in the parent frame, then the joint.
    const ax = anchorX[i]!, ay = anchorY[i]!;
    let px = pX + ax * pC - ay * pS;
    let py = pY + ax * pS + ay * pC;
    let a = pA + baseAngle[i]!;
    if (jointType[i] === JOINT_HINGE) {
      a += v;
    } else if (jointType[i] === JOINT_SLIDE) {
      const c0 = Math.cos(a), s0 = Math.sin(a);
      const lx = axisX[i]! * v, ly = axisY[i]! * v;
      px += lx * c0 - ly * s0;
      py += lx * s0 + ly * c0;
    }
    x[i] = px;
    y[i] = py;
    angle[i] = a;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  return out;
}

/** True once `nowTick` is at or past the clip's last key (it now holds). */
export function clipFinished(rig: Rig, playing: PlayingClip, nowTick: number): boolean {
  const cs = rig.clips;
  for (let i = 0; i < cs.length; i++) {
    if (cs[i]!.id === playing.clipId) return nowTick - playing.startTick >= cs[i]!.endTick;
  }
  return true;
}

/**
 * Is the rig DEPLOYED at `nowTick` under clip record `playing` (null = no
 * clip: the rig's idle pose)? True when the rig has no lift joint, or every
 * lift joint is fully raised (`liftProgress` 1). A pop-up weapon fires only
 * while deployed: one packed under its hatch, or still rising or sinking,
 * holds fire. Pure; poses into the caller's `scratch` (`createRigPose(rig)`),
 * allocation-free.
 */
export function rigDeployed(rig: Rig, playing: PlayingClip | null, nowTick: number, scratch: RigPose): boolean {
  const jt = rig.jointType;
  let anyLift = false;
  for (let i = 0; i < rig.partCount; i++) if (jt[i] === JOINT_LIFT) { anyLift = true; break; }
  if (!anyLift) return true;
  evaluateRig(rig, playing, nowTick, scratch);
  for (let i = 0; i < rig.partCount; i++) {
    if (jt[i] === JOINT_LIFT && liftProgress(rig, i, scratch.value[i]!) < 1) return false;
  }
  return true;
}
