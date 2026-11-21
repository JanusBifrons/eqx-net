/**
 * Eased resume offset for drones and scrap (netcode gap smoothing, S4b).
 *
 * Through a whole-stream stall the hold (S4-5, `swarmInterpolation.ts`) parks
 * the read point at "stream newest + glide limit": every drone is drawn at
 * its newest sample glided in a STRAIGHT line, and stays there. When packets
 * return, the read point resumes inside real samples, and a drone that was
 * turning is drawn on its true curve: one visible step sideways (2.6-3.3 u at
 * a 0.4-0.6 s gap).
 *
 * On the held frames this module keeps the pose it drew. On the resume frame
 * (packets caught up; never a re-sync) it takes the difference between that
 * held pose moved on by one frame of motion and the pose the samples give,
 * and eases it out with the remote-ship offset springs (`stepRemoteShipOffset`,
 * WALL time like every error-smoothing spring:
 * docs/architecture/game-time-scale.md). A difference too large for real
 * motion over the stall (`isImplausibleJump`, span in game ms) is a teleport
 * and is never eased.
 *
 * Drawing only: the result is the pose `updateSwarmMirror` writes into the
 * mirror entry. Physics reads the pose ring (`authoritativeSwarmStateAt`),
 * never this. The offset object is created once with the entry; nothing here
 * allocates, an idle offset (`halfLifeMs === 0`) costs one compare, and the
 * held pose is written only while a stall holds.
 */
import type { SwarmRenderState, SwarmResumeOffset, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import {
  interpolateSwarmPose,
  getSwarmDisplayDelayMs,
  getSwarmDisplaySpeed,
  getSwarmResyncCount,
  getSwarmStreamNewestStampMs,
  isSwarmHoldActive,
  type InterpolatedPose,
} from './swarmInterpolation.js';
import { stepRemoteShipOffset } from './remoteLerpOffsets.js';
import { isImplausibleJump } from './plausibleSpeed.js';
import { ANGLE_NOISE_THRESHOLD, REMOTE_SPRING_POS_END } from './predictionTuning.js';

/** Half-life (wall ms) of the resume offset's position springs. Long enough
 *  that a few units ease out well under the 2 u per-frame snap tolerance,
 *  short enough to be gone in well under half a second. The angle uses the
 *  remote-ship angle half-life inside `stepRemoteShipOffset`. */
export const SWARM_RESUME_OFFSET_HALF_LIFE_MS = 100;

const MS_PER_S = 1000;

// The hold, seen frame by frame (wall ms; one set for the whole swarm). The
// last held frame's time, stream newest stamp, parked read point and re-sync
// count; and the frame the stream caught up on (the resume frame).
let _heldFrameMs = Number.NaN;
let _parkedNewestMs = Number.NaN;
let _parkedTargetMs = Number.NaN;
let _heldResyncCount = 0;
let _resumeFrameMs = Number.NaN;

/** Note this frame's hold state; on the resume frame (the first frame after a
 *  hold that is not a re-sync) return the stream newest stamp the hold parked
 *  on, else NaN. Cheap and idempotent within a frame. */
function noteHoldFrame(nowMs: number): number {
  if (isSwarmHoldActive()) {
    if (nowMs !== _heldFrameMs) {
      _heldFrameMs = nowMs;
      _parkedNewestMs = getSwarmStreamNewestStampMs();
      _parkedTargetMs = nowMs - getSwarmDisplayDelayMs();
      _heldResyncCount = getSwarmResyncCount();
    }
    return Number.NaN;
  }
  if (Number.isFinite(_heldFrameMs) && nowMs !== _heldFrameMs) {
    _resumeFrameMs = getSwarmResyncCount() === _heldResyncCount ? nowMs : Number.NaN;
    _heldFrameMs = Number.NaN;
  }
  return nowMs === _resumeFrameMs ? _parkedNewestMs : Number.NaN;
}

/** A fresh, idle offset (the decoder calls this once per moving entry). */
export function makeSwarmResumeOffset(): SwarmResumeOffset {
  return {
    sx: { x: 0, v: 0 }, sy: { x: 0, v: 0 }, sa: { x: 0, v: 0 }, halfLifeMs: 0,
    heldX: Number.NaN, heldY: Number.NaN, heldAngle: Number.NaN,
  };
}

/** Back to idle: zero offset, zero rate, no held pose. */
export function clearSwarmResumeOffset(off: SwarmResumeOffset): void {
  off.sx.x = 0; off.sx.v = 0;
  off.sy.x = 0; off.sy.v = 0;
  off.sa.x = 0; off.sa.v = 0;
  off.halfLifeMs = 0;
  off.heldX = Number.NaN;
  off.heldY = Number.NaN;
  off.heldAngle = Number.NaN;
}

function clearEntryOffset(e: SwarmRenderState): void {
  if (e.resumeOffset) clearSwarmResumeOffset(e.resumeOffset);
}

/** Clear every entry's offset and the hold tracking (sector change:
 *  `resetPredictionState`). */
export function clearSwarmResumeOffsets(swarm: ReadonlyMap<number, SwarmRenderState> | undefined): void {
  if (swarm) swarm.forEach(clearEntryOffset);
  _heldFrameMs = Number.NaN;
  _parkedNewestMs = Number.NaN;
  _parkedTargetMs = Number.NaN;
  _heldResyncCount = 0;
  _resumeFrameMs = Number.NaN;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * The drawn pose of a drone or scrap piece at wall time `nowMs`: the
 * interpolated pose (`interpolateSwarmPose`) plus its eased resume offset.
 * `frameWallMs` is this frame's wall time step (the spring clock). Call once
 * per entry per frame, after `stepSwarmDisplayDelay`. Mutates `out`.
 */
export function resolveSwarmDrawnPose(
  entry: SwarmRenderState,
  nowMs: number,
  frameWallMs: number,
  out: InterpolatedPose,
): InterpolatedPose {
  interpolateSwarmPose(entry, nowMs, out);
  const off = entry.resumeOffset;
  if (off === undefined) return out;
  const cutoffMs = noteHoldFrame(nowMs);
  const captured = Number.isFinite(cutoffMs) && captureOnResume(entry, off, nowMs, cutoffMs, out);
  if (!captured && off.halfLifeMs > 0) {
    if (!stepRemoteShipOffset(off, frameWallMs)) clearSwarmResumeOffset(off);
  }
  if (off.halfLifeMs > 0) {
    out.x += off.sx.x;
    out.y += off.sy.x;
    out.angle += off.sa.x;
  }
  if (isSwarmHoldActive()) {
    off.heldX = out.x;
    off.heldY = out.y;
    off.heldAngle = out.angle;
  }
  return out;
}

/** The newest ring sample at or before `targetMs` (else the oldest). */
function sampleAt(ring: ReadonlyArray<PoseRingEntry>, targetMs: number): PoseRingEntry | null {
  let best: PoseRingEntry | null = null;
  let oldest: PoseRingEntry | null = null;
  for (let i = 0; i < ring.length; i++) {
    const e = ring[i]!;
    if (e.empty) continue;
    if (oldest === null || e.arrivalMs < oldest.arrivalMs) oldest = e;
    if (e.arrivalMs <= targetMs && (best === null || e.arrivalMs > best.arrivalMs)) best = e;
  }
  return best ?? oldest;
}

/** On the hold's resume frame, re-anchor `off` so the drawn pose continues
 *  from the held pose by one frame of motion, then eases to the samples.
 *  True when it re-anchored (the offset is applied in full this frame). */
function captureOnResume(
  entry: SwarmRenderState, off: SwarmResumeOffset, nowMs: number, cutoffMs: number, resolved: InterpolatedPose,
): boolean {
  const heldX = off.heldX;
  const heldY = off.heldY;
  const heldAngle = off.heldAngle;
  off.heldX = Number.NaN;
  off.heldY = Number.NaN;
  off.heldAngle = Number.NaN;
  // Not drawn on the last held frame (appeared since), or not interpolated.
  if (!Number.isFinite(heldX) || entry.sleeping || entry.warp === 2 || entry.warp === 3) return false;
  const s = sampleAt(entry.poseRing, nowMs - getSwarmDisplayDelayMs());
  if (s === null) return false;
  const speed = getSwarmDisplaySpeed();
  const targetMs = nowMs - getSwarmDisplayDelayMs();
  // This frame's motion: the read point moved on from where it was parked
  // (wall ms); v is per game second.
  const dt = (Math.max(0, targetMs - _parkedTargetMs) * speed) / MS_PER_S;
  const ox = heldX + s.vx * dt - resolved.x;
  const oy = heldY + s.vy * dt - resolved.y;
  const oa = wrapPi(heldAngle + s.angvel * dt - resolved.angle);
  const dist = Math.hypot(ox, oy);
  // Teleport guard: the span the drone moved unseen, read point to newest
  // pre-stall stamp, in game ms. Never ease across a discontinuity.
  if (isImplausibleJump(dist, Math.max(0, targetMs - cutoffMs) * speed)) {
    clearSwarmResumeOffset(off);
    return false;
  }
  if (dist <= REMOTE_SPRING_POS_END && Math.abs(oa) <= ANGLE_NOISE_THRESHOLD) return false;
  off.sx.x = ox; off.sx.v = 0;
  off.sy.x = oy; off.sy.v = 0;
  off.sa.x = oa; off.sa.v = 0;
  off.halfLifeMs = SWARM_RESUME_OFFSET_HALF_LIFE_MS;
  return true;
}
