/**
 * Display-delay MODE (netcode gap smoothing S5-9): pilot vs off-pilot, the
 * pilot catch-up after a switch, and the gap peak the off-pilot target is
 * sized from. One record, owned by `swarmInterpolation.ts` next to the drone
 * delay record; the slew and hold themselves stay in `displayDelayHold.ts`.
 *
 * - `pilot` (the local player is flying): the S5-7 target, capped at
 *   ADAPTIVE_DELAY_CEILING_MS, hold maximum MAX_TOTAL_DISPLAY_DELAY_MS.
 *   Exactly the #1201 behaviour.
 * - `offPilot` (Command, Build, spectate): the target may grow to the gap peak
 *   + margin, up to OFF_PILOT_DELAY_CEILING_MS; the hold may hold up to
 *   OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS before it re-syncs.
 * - On switching back to `pilot` with a delay above the pilot target, the
 *   record is in CATCH-UP: the off-pilot bounds stay in force (no clamp
 *   teleport) while the delay shrinks at the fast catch-up slew; catch-up ends
 *   once both the delay and the steady delay are at the pilot target.
 *
 * The gap peak is tracked in BOTH modes, so a switch to off-pilot covers the
 * outages of the last ~25 s at once. Scalars only; no allocation.
 */
import {
  OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS,
  createGapPeakState,
  stepGapPeak,
  type GapPeakState,
  type SwarmDelayMode,
} from './swarmDelaySizing.js';
import type { DisplayDelayHoldState } from './displayDelayHold.js';

/** The mode record. Mutated in place. */
export interface SwarmDelayModeState {
  /** The mode the caller asked for this frame. */
  mode: SwarmDelayMode;
  /** True from an off-pilot → pilot switch until the delay is back at the
   *  pilot target (the fast shrink; off-pilot bounds still apply). */
  catchUp: boolean;
  /** The decaying peak of stream staleness (wall ms). */
  gap: GapPeakState;
}

/** A fresh record: pilot, no catch-up, gap peak zero. */
export function createSwarmDelayModeState(): SwarmDelayModeState {
  return { mode: 'pilot', catchUp: false, gap: createGapPeakState() };
}

/** Back to pilot, no catch-up, gap peak zero (sector change, tests). */
export function resetSwarmDelayModeState(m: SwarmDelayModeState): void {
  m.mode = 'pilot';
  m.catchUp = false;
  m.gap.peakMs = 0;
  m.gap.ageMs = 0;
}

/** True while the off-pilot bounds apply: off pilot, or catching up. */
export function isOffPilotBoundsActive(m: SwarmDelayModeState): boolean {
  return m.mode === 'offPilot' || m.catchUp;
}

/** Set the mode. Off-pilot → pilot starts catch-up (ended by
 *  `settleCatchUp`); pilot → off-pilot ends any catch-up. Returns true when
 *  the mode changed. */
export function switchSwarmDelayMode(m: SwarmDelayModeState, next: SwarmDelayMode): boolean {
  if (next === m.mode) return false;
  m.catchUp = next === 'pilot';
  m.mode = next;
  return true;
}

/** End catch-up once the record's delay and steady delay are at (or under)
 *  its target. Call after the frame's slew. */
export function settleCatchUp(m: SwarmDelayModeState, s: DisplayDelayHoldState): void {
  if (m.catchUp && s.delayMs <= s.targetMs && s.steadyMs <= s.targetMs) m.catchUp = false;
}

/** The hold maximum (wall ms) for `holdDisplayDelay`: undefined in pure pilot
 *  (the S5-5 maximum, unchanged), else OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS
 *  ÷ speed. */
export function swarmHoldMaxWallMs(m: SwarmDelayModeState, speed: number): number | undefined {
  return isOffPilotBoundsActive(m) ? OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS / speed : undefined;
}

/** Longest frame (wall ms) whose staleness the gap peak takes: a longer one
 *  is the page itself stalled (a hidden tab, a long task), not the link. */
export const GAP_SAMPLE_MAX_FRAME_MS = 250;

/** Fold one frame's stream staleness into the gap peak: `nowMs` minus the
 *  stream's newest stamp, over a frame of `frameDtMs` wall ms. A frame with no
 *  stream yet, no read clock, or longer than GAP_SAMPLE_MAX_FRAME_MS is
 *  skipped. */
export function noteSwarmStaleness(
  m: SwarmDelayModeState, nowMs: number, newestStampMs: number, frameDtMs: number,
): void {
  if (!Number.isFinite(nowMs) || !Number.isFinite(newestStampMs)) return;
  if (!(frameDtMs > 0) || frameDtMs > GAP_SAMPLE_MAX_FRAME_MS) return;
  stepGapPeak(m.gap, nowMs - newestStampMs, frameDtMs);
}

/** Off pilot, a drone packet more than this (game ms) later than the tick
 *  clock is OUTAGE BACKLOG: the link held it, the server sent it on time. */
export const OFF_PILOT_BACKLOG_LATE_MS = 100;

/** True when a packet `lateMs` (wall ms) later than the tick clock is outage
 *  backlog the tick clock must keep its offset for (S5-9): off-pilot bounds
 *  active, later than OFF_PILOT_BACKLOG_LATE_MS ÷ speed and no later than
 *  OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS ÷ speed. The backlog is then stamped at
 *  its send-time place, so the off-pilot delay plays the outage through as
 *  continuous motion; in pilot (or past the maximum) the S4 re-seed / drift
 *  rules apply unchanged. */
export function isOffPilotClockBacklog(m: SwarmDelayModeState, lateMs: number, speed: number): boolean {
  return isOffPilotBoundsActive(m) && lateMs > OFF_PILOT_BACKLOG_LATE_MS / speed
    && lateMs <= OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS / speed;
}
