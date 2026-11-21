/**
 * Sizing rules for the drone display delay (netcode gap smoothing): the
 * floor, adaptive ceiling and hold maximum, the glide limit, the slew rates,
 * the inter-arrival estimator that sizes the target, and the hold bound. Pure
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

/** Hard ceiling on the adaptive delay target (GAME ms; wall = 150 / speed).
 *  Past this the perceived latency starts to feel unresponsive even if motion
 *  is smooth. Lowered 280 → 150 (netcode gap smoothing, S5-7, owner decision
 *  "cap delay + fix hold"): sizing the target from measured packet lateness
 *  (est + 4 × dev + one frame) pinned a jittery 4G link at 280 most of the
 *  time and drew drones ~300 ms late (main ~125). The target follows the
 *  swarm inter-arrival time again (`nextSwarmInterArrivalEwmaMs` ×
 *  ADAPTIVE_DELAY_FACTOR + drop bias) and stops here: late packets and short
 *  gaps are covered by the 250 ms glide and the stall hold, not a bigger
 *  steady buffer. A decimated drone (one packet per ~100–170 ms) may glide
 *  briefly between packets; it is not the threat. */
export const ADAPTIVE_DELAY_CEILING_MS = 150;

/** Delay target = swarm inter-arrival EWMA × this (+ the snapshot drop bias,
 *  `computeInterpBiasMs`): 1.5 packet gaps of buffer keep a bracketing pair
 *  through ordinary jitter. Clamped to the floor and ceiling. */
export const ADAPTIVE_DELAY_FACTOR = 1.5;
/** Largest inter-arrival sample (wall ms) the EWMA takes: one long gap (a
 *  stall, an idle sector) must not drag the estimate for seconds after. */
export const SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS = 500;
/** Weight the EWMA keeps on its previous value per binary swarm packet. */
export const SWARM_INTER_ARRIVAL_KEEP = 0.85;

/** The swarm inter-arrival EWMA (wall ms) after one more binary swarm packet
 *  arrived `dtMs` wall ms after the previous one: the first sample seeds it
 *  (`prevEwmaMs` 0), later ones blend in at 1 − SWARM_INTER_ARRIVAL_KEEP; the
 *  sample is capped at SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS. A non-positive or
 *  non-finite `dtMs` (two packets drained in one frame) leaves it alone. Pure. */
export function nextSwarmInterArrivalEwmaMs(prevEwmaMs: number, dtMs: number): number {
  if (!(dtMs > 0)) return prevEwmaMs;
  const sample = Math.min(SWARM_INTER_ARRIVAL_SAMPLE_CAP_MS, dtMs);
  return prevEwmaMs === 0 ? sample : prevEwmaMs * SWARM_INTER_ARRIVAL_KEEP + sample * (1 - SWARM_INTER_ARRIVAL_KEEP);
}

/** Largest total drone display delay (GAME ms; wall = 400 / speed, the same
 *  convention as the floor and ceiling). Netcode gap smoothing S4, owner
 *  decision D2: the steady delay (≤ the ceiling) may grow to 400 while playback holds its
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
 *  the eye reads as a hitch. A 100 → 150 ms step takes ≥ 0.5 s at 1×.
 *  A ratio, so it needs no speed scaling (the range itself is ÷ speed). */
export const DISPLAY_DELAY_SLEW_MAX_RATE = 0.1;
/** Within this (wall ms) of the target the value lands on it exactly. */
export const DISPLAY_DELAY_SLEW_SNAP_MS = 0.01;

/** One server tick in game ms (the room steps at 60 Hz game time). */
export const SERVER_TICK_MS = 1000 / 60;

// Maximum total display delay + counted re-sync (netcode gap smoothing, S4-4).
// The S4-5 hold lets the delay grow during a stream stall (read point held at
// the stream newest stamp + glide cap) and bounds it here.

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

// Off-pilot buffer (netcode gap smoothing S5-9). While the local player is
// not at the controls (Command, Build, spectate) nothing on screen is
// predicted at present time and orders take seconds anyway, so lag should
// read as DELAY, never as a pause-then-glide. Off pilot the target may grow
// past ADAPTIVE_DELAY_CEILING_MS to cover the recent link outages: the
// decaying peak of how stale the stream newest stamp got (`stepGapPeak`)
// plus a margin, up to OFF_PILOT_DELAY_CEILING_MS. Piloting keeps the S5-7
// target exactly. The gap peak and the mode live in `swarmDelayMode.ts`.

/** The display-delay sizing mode: `pilot` (the S5-7 target, capped at
 *  ADAPTIVE_DELAY_CEILING_MS) or `offPilot` (sized to recent outages). */
export type SwarmDelayMode = 'pilot' | 'offPilot';

/** Hard ceiling on the OFF-PILOT delay target (GAME ms; wall = 3000 / speed,
 *  like the pilot ceiling). Covers the 0.5–3 s outages of a bad 4G link; a
 *  longer one is held and then re-synced. */
export const OFF_PILOT_DELAY_CEILING_MS = 3000;
/** Largest total off-pilot delay (GAME ms; wall = 4000 / speed): the off-pilot
 *  stall hold may grow the delay to here before it re-syncs. Above the
 *  off-pilot ceiling so a slightly longer outage than the last one still
 *  holds its place instead of snapping. */
export const OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS = 4000;
/** Margin (wall ms) over the gap peak: one late packet past the worst recent
 *  gap still finds a bracketing pair. */
export const OFF_PILOT_GAP_MARGIN_MS = 100;
/** How long (wall ms) a gap peak is kept at full size before it decays: the
 *  "last ~20–30 s" of outages the off-pilot target covers. */
export const OFF_PILOT_GAP_HOLD_MS = 25_000;
/** Decay time constant (wall ms) of a gap peak once it is older than
 *  OFF_PILOT_GAP_HOLD_MS: the off-pilot target comes back down over ~15 s. */
export const OFF_PILOT_GAP_DECAY_TAU_MS = 5000;
/** A staleness of at least this fraction of the peak re-arms the hold: a
 *  repeat outage about as long as the peak (a few ms shorter, by jitter)
 *  keeps it remembered instead of letting it decay. */
export const OFF_PILOT_GAP_REFRESH_FRACTION = 0.9;

/** Pilot catch-up slew (S5-9): on entering pilot with a large off-pilot
 *  delay, the delay shrinks at this time constant (GAME ms, ÷ speed) ... */
export const DISPLAY_DELAY_CATCHUP_TAU_MS = 60;
/** ... and at most this fraction of the frame's wall time per frame: the read
 *  point plays up to 7× real time, so a 3 s delay is gone in ~0.5 s (a fast
 *  forward, never a teleport; the read point never moves backwards). Only
 *  shrinking uses it; growing keeps DISPLAY_DELAY_SLEW_MAX_RATE. */
export const DISPLAY_DELAY_CATCHUP_MAX_RATE = 6;

/** Ring headroom slots kept out of the off-pilot thinning (arrival jitter, the
 *  head slot), the same headroom `POSE_RING_DEPTH` is sized with. */
export const RING_THINNING_HEADROOM_SLOTS = 4;
/** The thinned ring covers this many times the delay it must hold. */
export const RING_THINNING_COVER_FACTOR = 1.25;

/** The delay target (wall ms) for a raw input `inputMs` (EWMA x factor + drop
 *  bias), game `speed`, `mode` and gap peak `gapPeakMs` (wall ms). `pilot`:
 *  the S5-7 clamp to [floor, ceiling] ÷ speed, unchanged. `offPilot`: that,
 *  or the gap peak + OFF_PILOT_GAP_MARGIN_MS when larger, capped at
 *  OFF_PILOT_DELAY_CEILING_MS ÷ speed. Pure. */
export function swarmDelayTargetWallMs(inputMs: number, speed: number, mode: SwarmDelayMode, gapPeakMs: number): number {
  const pilot = Math.max(DISPLAY_DELAY_MS / speed, Math.min(ADAPTIVE_DELAY_CEILING_MS / speed, inputMs));
  if (mode === 'pilot' || !(gapPeakMs > 0)) return pilot;
  return Math.max(pilot, Math.min(OFF_PILOT_DELAY_CEILING_MS / speed, gapPeakMs + OFF_PILOT_GAP_MARGIN_MS));
}

/** A decaying peak of stream staleness (wall ms). Mutated in place. */
export interface GapPeakState {
  /** The peak: the largest recent staleness, decaying once old. */
  peakMs: number;
  /** Wall ms since the peak was last raised or re-armed. */
  ageMs: number;
}

/** A fresh gap peak at zero. */
export function createGapPeakState(): GapPeakState {
  return { peakMs: 0, ageMs: 0 };
}

/** Fold one frame's stream staleness `stalenessMs` (now − stream newest
 *  stamp, wall ms) in after `frameDtMs` wall ms: a larger staleness becomes
 *  the peak at age 0, and one of at least OFF_PILOT_GAP_REFRESH_FRACTION of
 *  it re-arms the age; otherwise the peak ages, and past OFF_PILOT_GAP_HOLD_MS
 *  decays at OFF_PILOT_GAP_DECAY_TAU_MS, never below the current staleness.
 *  Non-finite or negative inputs do nothing. Pure over the record. */
export function stepGapPeak(s: GapPeakState, stalenessMs: number, frameDtMs: number): void {
  if (!(stalenessMs >= 0) || !(frameDtMs >= 0) || !Number.isFinite(stalenessMs) || !Number.isFinite(frameDtMs)) return;
  if (stalenessMs >= s.peakMs * OFF_PILOT_GAP_REFRESH_FRACTION) {
    s.peakMs = Math.max(s.peakMs, stalenessMs);
    s.ageMs = 0;
    return;
  }
  s.ageMs += frameDtMs;
  if (s.ageMs > OFF_PILOT_GAP_HOLD_MS) {
    s.peakMs = Math.max(stalenessMs, s.peakMs * Math.exp(-frameDtMs / OFF_PILOT_GAP_DECAY_TAU_MS));
  }
}

/** Least spacing (wall ms) between ring samples so a ring of `depth` slots
 *  covers `delayMs` (× RING_THINNING_COVER_FACTOR) with
 *  RING_THINNING_HEADROOM_SLOTS to spare. 0 for a non-positive delay. Pure. */
export function ringThinningSpacingMs(delayMs: number, depth: number): number {
  const slots = depth - RING_THINNING_HEADROOM_SLOTS;
  if (!(delayMs > 0) || slots <= 0) return 0;
  return (delayMs * RING_THINNING_COVER_FACTOR) / slots;
}
