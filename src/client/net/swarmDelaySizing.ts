/**
 * Sizing rules for the drone display delay (netcode gap smoothing): the
 * floor, adaptive ceiling and hold maximum, the glide limit, the slew rates,
 * the lateness estimator and the target it gives, and the hold bound. Pure
 * constants and functions, no module state: the delay itself, the tick clock
 * and the counters live in `swarmInterpolation.ts`, which re-exports all of
 * this so importers keep one entry point.
 */

/** Default / minimum display delay — the FEEL CORE of the drone
 * snapshot-interpolation pivot (Step 4, 2026-05-18).
 *
 * History:
 *   - Original: 100 ms — generous buffer when arrival jitter was unknown.
 *   - Network-feel Stage 0: 50 ms.
 *   - 2026-05-09: 0 ms — when drones were client-AI re-simmed in predWorld
 *     and the renderer read the predWorld pose, a non-zero delay made the
 *     *rendered* sprite lag the *predWorld collision body*, so you could
 *     visually overlap a drone and pass through it. 0 ms aligned render
 *     with the predWorld dead-reckon.
 *   - 2026-05-18 (the pivot): back to a 100 ms floor.
 *
 * Why the 0 ms rationale no longer applies: drones are no longer
 * client-AI re-simmed. They are PURE snapshot-interpolated off the
 * decoder `poseRing`, and the predWorld drone body is a KINEMATIC
 * follower driven to that *same* interpolated pose each frame
 * (`ColyseusClient.updateMirror`). Render and collision are now the
 * identical pose by construction at ANY delay — the visible-vs-collision
 * mismatch that forced 0 ms is structurally gone.
 *
 * What 100 ms buys: in-interest combat drones arrive on the binary wire
 * ~per server tick (≈16 ms). A 100 ms backward buffer means two
 * bracketing samples essentially always exist, so the hot path is a
 * genuine lerp of buffered authoritative truth — zero steady-state
 * extrapolation, total immunity to wire-arrival jitter ≤ 100 ms. The
 * cost is a fixed ~100 ms of perceived latency on drone visuals, which
 * is the deliberate, standard "render the past" cheat (Quake / Source /
 * Overwatch). 100 ms is the classic value and the on-device tuning knob
 * (the plan says start 80–110 ms; raise/lower here from device feel).
 *
 * NOTE: this is also the hard floor in `setSwarmDisplayDelayMs`'s clamp,
 * so the adaptive feed can only ever push the delay UP from here. Tests
 * that need a different effective delay must read it back via
 * `getSwarmDisplayDelayMs()` rather than assuming their argument sticks.
 */
export const DISPLAY_DELAY_MS = 100;

/** Maximum dead-reckoning (glide) window past the newest arrival before
 *  freezing, in GAME ms: in wall ms it is 250 / speed, like the delay floor
 *  and ceiling (`glideLimitWallMs`). Raised 100 → 250 (netcode gap smoothing,
 *  S4-1): a 200 ms packet gap outran the 100 ms glide and froze drones; 250
 *  matches the missile cap (`MISSILE_EXTRAPOLATION_CAP_MS`). The glide reads
 *  forward from the newest pose only, so it needs no older ring history. */
export const EXTRAPOLATION_LIMIT_MS = 250;

/** Hard ceiling on adaptive delay — past this the perceived latency starts
 *  to feel unresponsive even if motion is smooth. Raised 200 → 280 for the
 *  drone snapshot-interpolation pivot (Step 4, 2026-05-18): an
 *  out-of-interest / decimated drone arrives every `DECIMATION_TICKS≈6`
 *  ticks ≈ 100–170 ms, so a 170 ms decimated cadence wants ~255 ms of
 *  buffer to still have two bracketing samples (the delay is now sized from
 *  measured packet lateness, S3-3; owner decision D2 keeps this ceiling).
 *  280 leaves headroom above that without feeling unresponsive
 *  for the combat pack (which is in-interest at ~per-tick cadence and sits
 *  near the 100 ms floor, nowhere near this ceiling). Distant decimated
 *  drones accept the added latency by design — they are not the threat;
 *  the teleport guard covers the in↔out re-acquire. */
export const ADAPTIVE_DELAY_CEILING_MS = 280;

/** Largest total drone display delay (GAME ms; wall = 400 / speed, the same
 *  convention as the floor and ceiling). Netcode gap smoothing S4, owner
 *  decision D2: 280 steady, allowed to grow to 400 while playback holds its
 *  place through a stream stall. A stall that would push it further (a gap
 *  over ~0.75 s, an idle sector resuming, a backgrounded tab) re-syncs the
 *  delay to its target in one step (`boundSwarmHoldDelayMs`). The pose ring
 *  is sized to hold it (`tests/unit/poseRingDepth.test.ts`). */
export const MAX_TOTAL_DISPLAY_DELAY_MS = 400;

/** Slew time constant (GAME ms, divided by the speed like the floor and
 *  ceiling): each frame the delay closes `1 − exp(−frameMs / τ)` of the
 *  remaining gap to its target (~5 % per 60 Hz frame at 1×), so a small
 *  target change settles in about a second. */
export const DISPLAY_DELAY_SLEW_TAU_MS = 300;
/** Slew rate bound: the delay moves at most this fraction of the frame's own
 *  wall time per frame, either way. Below 1 the read point (now − delay)
 *  always advances (≥ 0.9× real time), so drones never stop or reverse from
 *  a delay change; 0.1 keeps the slow-down / speed-up under 10 %, below what
 *  the eye reads as a hitch. A 100 → 280 ms step takes ≥ 1.8 s at 1×.
 *  A ratio, so it needs no speed scaling (the range itself is ÷ speed). */
export const DISPLAY_DELAY_SLEW_MAX_RATE = 0.1;
/** Within this (wall ms) of the target the value lands on it exactly. */
export const DISPLAY_DELAY_SLEW_SNAP_MS = 0.01;

/** How many lateness deviations of headroom the target keeps above the
 *  smoothed lateness (RFC 6298's RTO = SRTT + 4 × RTTVAR). */
export const LATENESS_TARGET_DEVIATIONS = 4;
/** "One frame" in the target (WALL ms, not ÷ speed: a display frame is wall
 *  time): a named 60 Hz frame, not the measured one, so a frame stall does
 *  not move the target. The read lands up to one frame after the newest
 *  packet's drain, so the buffer must reach one frame further back. */
export const LATENESS_TARGET_FRAME_MS = 1000 / 60;

/**
 * The display-delay target (WALL ms) for a lateness estimate and deviation
 * (wall ms) at game speed `speed`:
 * `max(floor, estimate + 4 × deviation + one frame)`, clamped to the ceiling,
 * where floor = DISPLAY_DELAY_MS / speed and ceiling =
 * ADAPTIVE_DELAY_CEILING_MS / speed (game ms ÷ speed = wall ms). Pure.
 */
export function swarmDisplayDelayTargetFromLatenessMs(estimateMs: number, deviationMs: number, speed: number): number {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.max(DISPLAY_DELAY_MS / s, Math.min(ADAPTIVE_DELAY_CEILING_MS / s, latenessTargetRawMs(estimateMs, deviationMs)));
}

/** The target before the floor/ceiling clamp (wall ms). */
export function latenessTargetRawMs(estimateMs: number, deviationMs: number): number {
  return estimateMs + LATENESS_TARGET_DEVIATIONS * deviationMs + LATENESS_TARGET_FRAME_MS;
}

/** One server tick in game ms (the room steps at 60 Hz game time). */
export const SERVER_TICK_MS = 1000 / 60;

// Drone lateness estimate (netcode gap smoothing, S3-1). Smoothed per-packet
// lateness (the S0-2 `lateMs` in `swarmArrivalStampMs`) plus its mean absolute deviation (RFC
// 6298 style). It sizes the display-delay TARGET (S3-3, see
// `swarmDisplayDelayTargetFromLatenessMs`); it drives no ring, playback or pose.
// Units: WALL ms, the same as `setSwarmDisplayDelayMs`'s input and the stored
// `_displayDelayMs` (its game-ms floor/ceiling are divided by the speed to wall
// ms). Gains are per packet; the time constants below are stated at the nominal
// one-packet-per-server-tick cadence (16.7 wall ms at 1×), so a faster or
// slower packet rate shortens or stretches them in wall time.
/** Rise time constant: a sample above the estimate is tracked in ~50 ms
 *  (gain ≈ 0.28: 90 % of a step up within 7 packets). */
export const LATENESS_RISE_TAU_MS = 50;
/** Fall time constant: a sample below the estimate decays over ~2000 ms
 *  (gain ≈ 0.008: after 1 s at 60 Hz ~60 % of a step down remains). */
export const LATENESS_FALL_TAU_MS = 2000;
/** Deviation time constant: ~250 ms (gain ≈ 0.065), symmetric. */
export const LATENESS_DEV_TAU_MS = 250;
const LATENESS_RISE_GAIN = 1 - Math.exp(-SERVER_TICK_MS / LATENESS_RISE_TAU_MS);
const LATENESS_FALL_GAIN = 1 - Math.exp(-SERVER_TICK_MS / LATENESS_FALL_TAU_MS);
const LATENESS_DEV_GAIN = 1 - Math.exp(-SERVER_TICK_MS / LATENESS_DEV_TAU_MS);

/** State of a lateness estimate (wall ms). Mutated in place, never reallocated. */
export interface LatenessEstimate {
  estimateMs: number;
  deviationMs: number;
}

/** Fold one lateness sample (wall ms) into `est`: rise fast, fall slowly; the
 *  deviation follows |sample − previous estimate| (RFC 6298 order). Pure on
 *  `est`, no allocation. */
export function updateLatenessEstimate(est: LatenessEstimate, sampleMs: number): void {
  const err = sampleMs - est.estimateMs;
  est.deviationMs += (Math.abs(err) - est.deviationMs) * LATENESS_DEV_GAIN;
  est.estimateMs += err * (err > 0 ? LATENESS_RISE_GAIN : LATENESS_FALL_GAIN);
}

// Maximum total display delay + counted re-sync (netcode gap smoothing, S4-4).
// Nothing calls these yet; S4-5 lets the delay grow during a stream stall
// (read point held at the stream newest stamp + glide cap) and bounds it here.

/** True when a requested hold delay (wall ms) passes
 *  MAX_TOTAL_DISPLAY_DELAY_MS / speed. A non-finite request counts as over
 *  (re-sync rather than read at a garbage delay). Pure. */
export function isSwarmHoldDelayOverMax(requestedDelayWallMs: number, speed: number): boolean {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return !(requestedDelayWallMs <= MAX_TOTAL_DISPLAY_DELAY_MS / s);
}

/** The delay (wall ms) a hold may use: the request while it is at or under
 *  MAX_TOTAL_DISPLAY_DELAY_MS / speed, otherwise `targetWallMs` (the
 *  re-sync: the delay resets to its target in one step). Pure; the caller
 *  checks `isSwarmHoldDelayOverMax` with the same inputs and calls
 *  `noteSwarmResync()` once for a re-sync. */
export function boundSwarmHoldDelayMs(requestedDelayWallMs: number, targetWallMs: number, speed: number): number {
  return isSwarmHoldDelayOverMax(requestedDelayWallMs, speed) ? targetWallMs : requestedDelayWallMs;
}
