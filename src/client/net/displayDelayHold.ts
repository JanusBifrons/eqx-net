/**
 * Display-delay slew and stream-stall hold (netcode gap smoothing S3-2, S4-5,
 * S5-5): ONE mechanism, run over a small state record per stream (owner
 * decision D10 = A). Drones (binary swarm stream) own one record in
 * `swarmInterpolation.ts`; missiles (JSON snapshot stream) own another in
 * `MissileMirror.ts`. The two connections can stall separately, so each
 * record holds on its own stream's newest stamp: a JSON-only stall holds
 * missiles and not drones, and the other way round.
 *
 * Per frame, in order: `slewDisplayDelay` moves the delay toward its target
 * (bounded rate), then `holdDisplayDelay` parks the read point (now − delay)
 * at "stream newest + glide limit" while the stream is stalled, so playback
 * resumes from the held place and the slew plays the catch-up. A stall that
 * would push the delay past MAX_TOTAL_DISPLAY_DELAY_MS / speed re-syncs to
 * the target in one step, counted once per stall.
 *
 * Pure functions over the record: no module state, no allocation.
 */
import {
  DISPLAY_DELAY_SLEW_MAX_RATE, DISPLAY_DELAY_SLEW_SNAP_MS, DISPLAY_DELAY_SLEW_TAU_MS,
  boundSwarmHoldDelayMs, isSwarmHoldDelayOverMax,
} from './swarmDelaySizing.js';

/** One stream's display delay and hold state (wall ms). Mutated in place. */
export interface DisplayDelayHoldState {
  /** The slewed (and possibly held) delay every read uses. */
  delayMs: number;
  /** Where the slew heads. */
  targetMs: number;
  /** True once the current stall has re-synced: no further growth until the
   *  stream catches up with the read point again. */
  resyncedThisStall: boolean;
  /** True while the hold has the read point parked (set by the last hold step). */
  holdActive: boolean;
  /** Frames on which the hold set the delay (telemetry). */
  holdFrameCount: number;
  /** Deliberate re-syncs: a hold that would pass the maximum (telemetry). */
  resyncCount: number;
}

/** A fresh record at `delayMs` (value and target), counters zero. */
export function createDisplayDelayHoldState(delayMs: number): DisplayDelayHoldState {
  return { delayMs, targetMs: delayMs, resyncedThisStall: false, holdActive: false, holdFrameCount: 0, resyncCount: 0 };
}

/** Put value and target at `delayMs` and clear the stall state (counters kept). */
export function resetDisplayDelayHold(s: DisplayDelayHoldState, delayMs: number): void {
  s.delayMs = delayMs;
  s.targetMs = delayMs;
  s.resyncedThisStall = false;
  s.holdActive = false;
}

/** Move the delay toward its target by one frame of `frameDtMs` wall ms:
 *  proportional to the remaining gap (time constant
 *  DISPLAY_DELAY_SLEW_TAU_MS of game time at `speed`), bounded to
 *  DISPLAY_DELAY_SLEW_MAX_RATE × frameDtMs either way. */
export function slewDisplayDelay(s: DisplayDelayHoldState, frameDtMs: number, speed: number): void {
  const remaining = s.targetMs - s.delayMs;
  if (remaining === 0 || !(frameDtMs > 0) || !Number.isFinite(frameDtMs)) return;
  const maxStep = DISPLAY_DELAY_SLEW_MAX_RATE * frameDtMs;
  if (Math.abs(remaining) <= Math.min(DISPLAY_DELAY_SLEW_SNAP_MS, maxStep)) {
    s.delayMs = s.targetMs;
    return;
  }
  const step = remaining * (1 - Math.exp(-frameDtMs * speed / DISPLAY_DELAY_SLEW_TAU_MS));
  s.delayMs += Math.max(-maxStep, Math.min(maxStep, step));
}

/** The stall hold for the frame read at `nowMs`: when the read point would
 *  pass `newestStampMs + glideLimitWallMs` (the stream's newest stamp plus
 *  the glide limit, all wall ms), grow the delay so it stays there; past
 *  MAX_TOTAL_DISPLAY_DELAY_MS / `speed`, re-sync to the target (counted once
 *  per stall). A non-finite `nowMs` or `newestStampMs` (no stream yet) does
 *  nothing but clear `holdActive`. */
export function holdDisplayDelay(
  s: DisplayDelayHoldState, nowMs: number, newestStampMs: number, glideLimitWallMs: number, speed: number,
): void {
  s.holdActive = false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(newestStampMs)) return;
  const requiredMs = nowMs - newestStampMs - glideLimitWallMs;
  if (!(requiredMs > s.delayMs)) {
    s.resyncedThisStall = false;
    return;
  }
  if (s.resyncedThisStall) return;
  if (isSwarmHoldDelayOverMax(requiredMs, speed)) {
    s.resyncCount++;
    s.resyncedThisStall = true;
  } else {
    s.holdActive = true;
    s.holdFrameCount++;
  }
  s.delayMs = boundSwarmHoldDelayMs(requiredMs, s.targetMs, speed);
}
