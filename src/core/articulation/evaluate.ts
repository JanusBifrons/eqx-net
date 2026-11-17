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
 *  - no clip, an unknown clip id, or `nowTick < startTick`: every part at rest;
 *  - a part without a track in the clip stays at rest;
 *  - a track's first key after tick 0 eases from rest at tick 0;
 *  - after a track's last key it holds that key;
 *  - every value is clamped to its joint limits.
 *
 * Targeted clips: keys marked `fromTarget` take their value from an injected
 * IK solver (`IkSolve`, the 2b solver lives in `ik.ts`). With no target or no
 * solver those keys fall back to rest.
 */
import { applyEase } from './easing.js';
import { JOINT_HINGE, type Rig } from './rig.js';

/** A clip playing on a rig: the whole wire record (2e). */
export interface PlayingClip {
  readonly clipId: string;
  /** Game tick the clip started on. */
  readonly startTick: number;
  /** Target point in the HOST frame, for a targeted clip. */
  readonly target?: { readonly x: number; readonly y: number };
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
  /** Target in the host frame. */
  targetX: number;
  targetY: number;
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
  readonly ikReq: IkRequest;
  /** Last IK verdict for the playing clip (true when none was asked). */
  ikReached: boolean;
}

/** Pre-size the evaluation scratch for `rig` (build time). */
export function createRigPose(rig: Rig): RigPose {
  const n = rig.partCount;
  return {
    value: new Float64Array(n), x: new Float64Array(n), y: new Float64Array(n),
    angle: new Float64Array(n), cos: new Float64Array(n), sin: new Float64Array(n),
    ikOut: new Float64Array(rig.maxChain),
    ikReq: {
      rig, chain: new Int16Array(0), originX: 0, originY: 0, originAngle: 0,
      tipX: 0, tipY: 0, targetX: 0, targetY: 0,
    },
    ikReached: true,
  };
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Evaluate one track at clip-local time `t` (>= 0). */
function sampleTrack(
  ticks: Float64Array, values: Float64Array, ease: Uint8Array, fromTarget: Uint8Array,
  restValue: number, ikValue: number, useIk: boolean, t: number,
): number {
  const m = ticks.length;
  let prevTick = 0;
  let prevVal = restValue;
  for (let k = 0; k < m; k++) {
    const kt = ticks[k]!;
    const kv = fromTarget[k] === 1 && useIk ? ikValue : values[k]!;
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

/**
 * Pose the rig at `nowTick` (game ticks; fractional ticks are allowed for
 * render interpolation). Writes `out`; returns `out`.
 */
export function evaluateRig(
  rig: Rig, playing: PlayingClip | null, nowTick: number, out: RigPose, ik?: IkSolve,
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
  }
  const clip = clipIdx >= 0 ? rig.clips[clipIdx]! : null;
  const target = playing !== null ? playing.target : undefined;
  const wantIk = clip !== null && clip.chain.length > 0 && target !== undefined && ik !== undefined;
  const chainRoot = wantIk ? clip.chain[0]! : -1;
  let ikDone = false;
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
      req.tipX = clip!.tipX; req.tipY = clip!.tipY;
      req.targetX = target!.x; req.targetY = target!.y;
      out.ikReached = ik!(req, ikOut);
      ikDone = true;
    }

    // Joint value.
    let v = rest[i]!;
    if (clip !== null) {
      const ti = clip.trackOfPart[i]!;
      if (ti >= 0) {
        const tr = clip.tracks[ti]!;
        const useIk = ikDone && tr.chainSlot >= 0;
        v = sampleTrack(tr.ticks, tr.values, tr.ease, tr.fromTarget, rest[i]!,
          useIk ? ikOut[tr.chainSlot]! : 0, useIk, t);
      }
    }
    v = clampTo(v, min[i]!, max[i]!);
    value[i] = v;

    // Forward kinematics: anchor in the parent frame, then the joint.
    const ax = anchorX[i]!, ay = anchorY[i]!;
    let px = pX + ax * pC - ay * pS;
    let py = pY + ax * pS + ay * pC;
    let a = pA + baseAngle[i]!;
    if (jointType[i] === JOINT_HINGE) {
      a += v;
    } else {
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
