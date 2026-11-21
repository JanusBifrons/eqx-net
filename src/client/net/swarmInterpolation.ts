/**
 * Time-based entity interpolation for swarm sprites — Phase 6.5 display-delay
 * variant.
 *
 * The renderer asks for an entity's pose at wall-clock time `nowMs`. We
 * actually serve the pose at `nowMs − DISPLAY_DELAY_MS`, walking the entity's
 * 3-deep `poseRing` to find the two arrivals that bracket that target time
 * and lerping between them. This trades a fixed ~100 ms of perceived latency
 * on swarm visuals for total immunity to wire-arrival jitter ≤ 100 ms — at
 * 4000 entities + GC bursts on Node, raw arrivals scatter ±30 ms; reading at
 * `now − 100` keeps interpolation driven by *render time*, not arrival time,
 * so the visible motion is a continuous lerp of buffered truth.
 *
 * Standard multiplayer pattern (Source / Quake heritage). See
 * docs/LESSONS.md for the why-not-arrival-time discussion.
 */
import type { SwarmRenderState, PoseRingEntry } from '../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';
import { isImplausibleJump } from './plausibleSpeed.js';
import {
  ADAPTIVE_DELAY_CEILING_MS, DISPLAY_DELAY_MS, DISPLAY_DELAY_SLEW_MAX_RATE, DISPLAY_DELAY_SLEW_SNAP_MS,
  DISPLAY_DELAY_SLEW_TAU_MS, EXTRAPOLATION_LIMIT_MS, SERVER_TICK_MS, latenessTargetRawMs, updateLatenessEstimate,
  boundSwarmHoldDelayMs, isSwarmHoldDelayOverMax,
  type LatenessEstimate,
} from './swarmDelaySizing.js';
/** The delay sizing rules (constants, lateness estimator, target, hold bound)
 *  live in `swarmDelaySizing.ts`; re-exported so importers keep one entry point. */
export {
  DISPLAY_DELAY_MS, EXTRAPOLATION_LIMIT_MS, ADAPTIVE_DELAY_CEILING_MS, MAX_TOTAL_DISPLAY_DELAY_MS,
  DISPLAY_DELAY_SLEW_TAU_MS, DISPLAY_DELAY_SLEW_MAX_RATE, DISPLAY_DELAY_SLEW_SNAP_MS,
  LATENESS_TARGET_DEVIATIONS, LATENESS_TARGET_FRAME_MS, swarmDisplayDelayTargetFromLatenessMs,
  LATENESS_RISE_TAU_MS, LATENESS_FALL_TAU_MS, LATENESS_DEV_TAU_MS, updateLatenessEstimate,
  isSwarmHoldDelayOverMax, boundSwarmHoldDelayMs,
} from './swarmDelaySizing.js';
export type { LatenessEstimate } from './swarmDelaySizing.js';

/** Teleport guard (drone snapshot-interpolation pivot, 2026-05-18): routing
 * drones through `interpolateSwarmPose` exposed server discontinuities that
 * the unconditional lerp animated across. The bound and its rationale live in
 * `plausibleSpeed.ts` (one definition, shared with the other-ship snap);
 * re-exported here so existing importers keep working. */
export { TELEPORT_MAX_PLAUSIBLE_SPEED, TELEPORT_FLOOR_U } from './plausibleSpeed.js';

/** Module-level adaptive delay: the SLEWED value every read uses (netcode gap
 *  smoothing S3-2). Every tick-stamped drone packet (`swarmArrivalStampMs`)
 *  sets `_displayDelayTargetMs` from the lateness estimate (S3-3,
 *  `swarmDisplayDelayTargetFromLatenessMs`); `stepSwarmDisplayDelay()` (once
 *  per frame, `updateSwarmMirror`) moves this value toward it, so a changed
 *  target glides instead of jumping the read point. On a good link the target
 *  is the 100 ms floor; when packets run late the target rises so the buffer
 *  still holds a bracketing pair. */
let _displayDelayMs = DISPLAY_DELAY_MS;
/** Where the slewed delay is heading (wall ms, already clamped). */
let _displayDelayTargetMs = DISPLAY_DELAY_MS;
/** False until the first target after a reset: that first target places the
 *  value AT it (no glide up from the floor). */
let _displayDelaySeeded = false;
/** True after `setSwarmDisplayDelayMs` (tests, fixed-delay harness runs): the
 *  lateness feed leaves the target alone until the next reset. */
let _displayDelayPinned = false;
/** The sector's game speed (time scale stream). The floor and ceiling are GAME
 *  ms, so in wall ms they are 100 / speed and 280 / speed: at 4× poses arrive
 *  4× as often and 25 wall ms still spans the same few of them (a fixed 100 ms
 *  would reach past `POSE_RING_DEPTH` and pin drones to a stale pose); at
 *  0.25× the buffer stretches to cover the slower arrivals. */
let _displaySpeed = 1;
let _lastDelayInputMs = DISPLAY_DELAY_MS;

/** The glide limit in wall ms at the current speed (game ms ÷ speed). */
function glideLimitWallMs(): number {
  return EXTRAPOLATION_LIMIT_MS / _displaySpeed;
}

function clampDisplayDelayWallMs(ms: number): number {
  return Math.max(DISPLAY_DELAY_MS / _displaySpeed, Math.min(ADAPTIVE_DELAY_CEILING_MS / _displaySpeed, ms));
}

function setDisplayDelayTarget(ms: number): void {
  _lastDelayInputMs = ms;
  _displayDelayTargetMs = clampDisplayDelayWallMs(ms);
  if (!_displayDelaySeeded) {
    _displayDelaySeeded = true;
    _displayDelayMs = _displayDelayTargetMs;
  }
}

/** Pin the display-delay TARGET (wall ms, clamped to the floor/ceiling) for
 *  tests and fixed-delay harness runs: the lateness feed stops moving it until
 *  the next reset. The value glides there in `stepSwarmDisplayDelay` (the
 *  first target after a reset places the value at it). Production does not
 *  call this: the target comes from the lateness estimate. */
export function setSwarmDisplayDelayMs(ms: number): void {
  _displayDelayPinned = true;
  setDisplayDelayTarget(ms);
}

/** Move the delay toward its target by one frame of `frameDtMs` wall ms:
 *  proportional to the remaining gap, bounded to
 *  `DISPLAY_DELAY_SLEW_MAX_RATE × frameDtMs` either way; then, given this
 *  frame's read clock `nowMs`, apply the stream-stall hold
 *  (`holdSwarmDisplayDelay`). Call once per frame, before any read
 *  (`updateSwarmMirror`). Without `nowMs` only the slew runs. Scalars only. */
export function stepSwarmDisplayDelay(frameDtMs: number, nowMs: number = Number.NaN): void {
  slewSwarmDisplayDelay(frameDtMs);
  holdSwarmDisplayDelay(nowMs);
}

function slewSwarmDisplayDelay(frameDtMs: number): void {
  const remaining = _displayDelayTargetMs - _displayDelayMs;
  if (remaining === 0 || !(frameDtMs > 0) || !Number.isFinite(frameDtMs)) return;
  const maxStep = DISPLAY_DELAY_SLEW_MAX_RATE * frameDtMs;
  if (Math.abs(remaining) <= Math.min(DISPLAY_DELAY_SLEW_SNAP_MS, maxStep)) {
    _displayDelayMs = _displayDelayTargetMs;
    return;
  }
  const step = remaining * (1 - Math.exp(-frameDtMs * _displaySpeed / DISPLAY_DELAY_SLEW_TAU_MS));
  _displayDelayMs += Math.max(-maxStep, Math.min(maxStep, step));
}

// Hold without losing the place (netcode gap smoothing, S4-5). When the WHOLE
// drone stream stalls, the read point (now − delay) would run past the
// stream's newest stamp + the glide limit and every drone would freeze there;
// when packets returned the read point was far ahead and drones snapped
// forward. Instead the delay grows so the read point stays at "stream newest +
// glide limit" (the same frozen pose), and playback resumes from that held
// point; the slew above then brings the delay back to its target, playing at
// most DISPLAY_DELAY_SLEW_MAX_RATE fast (no second catch-up mechanism). Bound:
// MAX_TOTAL_DISPLAY_DELAY_MS / speed (S4-4); a stall that would pass it
// re-syncs the delay to its target in one step, counted once per stall. A
// drone missing from recent packets while the stream is alive keeps the
// per-entity glide-then-freeze in `interpolateSwarmPose`. Scalars only.
/** True once the current stall has re-synced: no further growth until the
 *  stream catches up with the read point again. */
let _holdResyncedThisStall = false;
/** True while the hold has the read point parked (set by the last step). The
 *  packets that end the stall are its backlog, all drained at once: while this
 *  is set they do not pull the tick clock later (`swarmArrivalStampMs`), so
 *  they keep their places on the timeline the held read point resumes along.
 *  Without that, ~36 backlog packets of a 600 ms stall drifted the clock
 *  ~100 ms late and drones stepped BACK on resume. */
let _holdActive = false;
/** Frames on which the hold set the delay (telemetry, like the counters below). */
let _holdFrameCount = 0;

function holdSwarmDisplayDelay(nowMs: number): void {
  _holdActive = false;
  const newestMs = _streamNewestStampMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(newestMs)) return;
  const requiredMs = nowMs - newestMs - glideLimitWallMs();
  if (!(requiredMs > _displayDelayMs)) {
    _holdResyncedThisStall = false;
    return;
  }
  if (_holdResyncedThisStall) return;
  if (isSwarmHoldDelayOverMax(requiredMs, _displaySpeed)) {
    noteSwarmResync();
    _holdResyncedThisStall = true;
  } else {
    _holdActive = true;
    _holdFrameCount++;
  }
  _displayDelayMs = boundSwarmHoldDelayMs(requiredMs, _displayDelayTargetMs, _displaySpeed);
}

/** Frames on which a stream stall held the read point (S4-5 telemetry). */
export function getSwarmHoldFrameCount(): number { return _holdFrameCount; }
/** True while a stream stall has the read point parked (S4b: swarmResumeOffset.ts). */
export function isSwarmHoldActive(): boolean { return _holdActive; }
/** The sector's game speed the swarm reads use (game ms per wall ms). */
export function getSwarmDisplaySpeed(): number { return _displaySpeed; }

/** Put the delay back at the floor with no target, no lateness estimate and
 *  no stream newest stamp (sector change: `resetPredictionState`; tests:
 *  `resetSwarmTickClock`).
 *  The next `setSwarmDisplayDelayMs` places the value at its target. */
export function resetSwarmDisplayDelay(): void {
  _lastDelayInputMs = DISPLAY_DELAY_MS;
  _displayDelayTargetMs = clampDisplayDelayWallMs(DISPLAY_DELAY_MS);
  _displayDelayMs = _displayDelayTargetMs;
  _displayDelaySeeded = false;
  _displayDelayPinned = false;
  _latenessEstimate.estimateMs = 0;
  _latenessEstimate.deviationMs = 0;
  _streamNewestTick = -1;
  _streamNewestStampMs = Number.NaN;
  _holdResyncedThisStall = false;
  _holdActive = false;
}

/** The sector's game speed, from the snapshot keyframe (ColyseusClient).
 *  The floor and ceiling move with it: the target is re-clamped and the
 *  slewed value is clamped into the new range AT ONCE (it must never sit
 *  outside the bounds); inside them it keeps gliding toward the target. */
export function setSwarmDisplaySpeed(speed: number): void {
  const next = Number.isFinite(speed) && speed > 0 ? speed : 1;
  if (next !== _displaySpeed && _tickClockSeeded) {
    // Keep the newest stamp where it is; later ticks space at the new rate.
    _tickClockOffsetMs = _tickClockLastStampMs - _tickClockLastTick * (SERVER_TICK_MS / next);
  }
  _displaySpeed = next;
  _displayDelayTargetMs = clampDisplayDelayWallMs(_lastDelayInputMs);
  _displayDelayMs = _displayDelaySeeded ? clampDisplayDelayWallMs(_displayDelayMs) : _displayDelayTargetMs;
}

/** An arrival this far (ms) off the tick clock is a new timeline (sector
 *  change, reconnect, a long stall), not jitter: re-seed. */
export const TICK_CLOCK_RESYNC_MS = 1000;
/** Per-packet pull of the tick clock toward a LATER arrival, so a one-off
 *  early packet doesn't hold every stamp early for good. Earlier arrivals
 *  take over at once (the clock tracks the least-delayed path). */
export const TICK_CLOCK_DRIFT_UP = 0.01;
let _tickClockSeeded = false;
let _tickClockOffsetMs = 0;
let _tickClockLastTick = 0;
let _tickClockLastStampMs = 0;

// Drone stream counters (netcode gap smoothing, S0-2). Read-only telemetry:
// nothing here feeds a pose, delay or clock. Scalars only (no allocation).
/** Wall ms the last tick-stamped packet arrived after its tick-clock stamp. */
let _latenessLastMs = 0;
/** Largest lateness (wall ms) seen since the last reset. */
let _latenessMaxMs = 0;
/** Sum of lateness (wall ms) over `_latenessCount` packets (mean = sum/count). */
let _latenessSumMs = 0;
/** Tick-stamped packets measured. */
let _latenessCount = 0;
/** Ring slots overwritten while their stamp was still newer than the read
 *  point (proxy for "not yet read": the ring has no per-slot read flag). */
let _overwriteUnreadCount = 0;
/** Reads whose target fell before the oldest pose of a FULL ring (old-end
 *  clamp: history the read needed was already overwritten). A newly seen
 *  drone whose ring is still filling is not counted. */
let _oldEndClampCount = 0;
/** Reads past the newest pose by more than EXTRAPOLATION_LIMIT_MS ÷ speed (frozen at
 *  the glide limit). Counted per entity per frame. */
let _glideLimitCount = 0;
/** Deliberate re-syncs: a held delay that would pass
 *  MAX_TOTAL_DISPLAY_DELAY_MS reset to its target in one step (S4-4). */
let _resyncCount = 0;
/** The read point: the target time of the latest interpolation read. NaN
 *  until the first read, so no overwrite counts before anything was read. */
let _lastReadTargetMs = Number.NaN;

const _latenessEstimate: LatenessEstimate = { estimateMs: 0, deviationMs: 0 };

// Drone stream newest stamp (netcode gap smoothing, S4-2). The display-time
// stamp (`swarmArrivalStampMs` units, wall ms) of the newest server tick seen
// in any tick-stamped swarm packet, so a hold can tell "the stream stalled"
// from "this drone was not in the packet". Nothing reads it yet (S4-4/S4-5).
// Rule: the packet with the NEWER server tick wins; an equal or older tick (a
// reordered or late packet) leaves it alone, so it never goes backwards on
// one. It may step back only when a newer tick lands on a re-seeded tick clock
// (a new timeline), which a plain max would hide behind a stale value.
// Scalars only (no allocation). Reset by `resetSwarmDisplayDelay`.
let _streamNewestTick = -1;
let _streamNewestStampMs = Number.NaN;

/** The decoder calls this once per tick-stamped swarm packet with the
 *  packet's server tick and its `swarmArrivalStampMs` stamp. */
export function noteSwarmStreamStamp(tick: number, stampMs: number): void {
  if (tick <= _streamNewestTick) return;
  _streamNewestTick = tick;
  _streamNewestStampMs = stampMs;
}

/** Display-time stamp (wall ms) of the newest drone packet; NaN before the
 *  first tick-stamped packet after a reset. */
export function getSwarmStreamNewestStampMs(): number { return _streamNewestStampMs; }

/** Count one deliberate re-sync (see `boundSwarmHoldDelayMs`). */
export function noteSwarmResync(): void { _resyncCount++; }

/**
 * The time a binary swarm packet of server tick `tick` is stamped with in the
 * pose ring (fleet-melee follow jitter, owner take 10). Stamping the raw
 * arrival time made the interpolated path jitter: packets drain once per RAF,
 * so two ticks decoded in one frame got the SAME stamp and the next frame got
 * none, and the lerp then ran at 0×, then 2× speed (a followed drone stepped
 * 0–5 u per frame at a steady ~2.8 u cruise). Ticks are evenly spaced in
 * server time, so stamps come from the tick on a clock fitted to arrivals:
 * `tick × tickMs + offset`, where `offset` follows the least-delayed arrival
 * (drifting up slowly) and never stamps a packet later than it arrived.
 */
export function swarmArrivalStampMs(tick: number, nowMs: number): number {
  const tickWallMs = SERVER_TICK_MS / _displaySpeed;
  const cand = nowMs - tick * tickWallMs;
  if (!_tickClockSeeded || Math.abs(cand - _tickClockOffsetMs) > TICK_CLOCK_RESYNC_MS) {
    _tickClockSeeded = true;
    _tickClockOffsetMs = cand;
  } else if (cand < _tickClockOffsetMs) {
    _tickClockOffsetMs = cand;
  } else if (!_holdActive) {
    // Not while the stall hold is parked: the backlog is late by design (S4-5).
    _tickClockOffsetMs += (cand - _tickClockOffsetMs) * TICK_CLOCK_DRIFT_UP;
  }
  const stamp = Math.min(nowMs, tick * tickWallMs + _tickClockOffsetMs);
  const lateMs = nowMs - stamp;
  _latenessLastMs = lateMs;
  if (lateMs > _latenessMaxMs) _latenessMaxMs = lateMs;
  _latenessSumMs += lateMs;
  _latenessCount++;
  updateLatenessEstimate(_latenessEstimate, lateMs);
  if (!_displayDelayPinned) {
    // Raw input (the setter clamps, as swarmDisplayDelayTargetFromLatenessMs),
    // so a later speed change re-clamps the same input.
    setDisplayDelayTarget(latenessTargetRawMs(_latenessEstimate.estimateMs, _latenessEstimate.deviationMs));
  }
  _tickClockLastTick = tick;
  _tickClockLastStampMs = stamp;
  return stamp;
}

/** Forget the tick clock, zero the drone stream counters and reset the
 *  display delay + lateness estimate (tests; a new room re-seeds on its own). */
export function resetSwarmTickClock(): void {
  _tickClockSeeded = false;
  _latenessLastMs = 0;
  _latenessMaxMs = 0;
  _latenessSumMs = 0;
  _latenessCount = 0;
  resetSwarmDisplayDelay();
  _overwriteUnreadCount = 0;
  _oldEndClampCount = 0;
  _glideLimitCount = 0;
  _resyncCount = 0;
  _holdFrameCount = 0;
  _lastReadTargetMs = Number.NaN;
}

/** The decoder calls this before writing over a populated ring slot. */
export function noteSwarmSlotOverwrite(slotArrivalMs: number): void {
  if (slotArrivalMs > _lastReadTargetMs) _overwriteUnreadCount++;
}

export function getSwarmLatenessLastMs(): number { return _latenessLastMs; }
export function getSwarmLatenessMaxMs(): number { return _latenessMaxMs; }
export function getSwarmLatenessSumMs(): number { return _latenessSumMs; }
export function getSwarmLatenessCount(): number { return _latenessCount; }
export function getSwarmOverwriteUnreadCount(): number { return _overwriteUnreadCount; }
export function getSwarmOldEndClampCount(): number { return _oldEndClampCount; }
export function getSwarmGlideLimitCount(): number { return _glideLimitCount; }
/** Deliberate re-syncs since the last reset (S4-4). */
export function getSwarmResyncCount(): number { return _resyncCount; }
/** Smoothed drone packet lateness (wall ms); sizes the display-delay target. */
export function getSwarmLatenessEstimateMs(): number { return _latenessEstimate.estimateMs; }
/** Smoothed mean absolute deviation of drone packet lateness (wall ms). */
export function getSwarmLatenessDeviationMs(): number { return _latenessEstimate.deviationMs; }

/** The slewed display delay every read uses (wall ms). */
export function getSwarmDisplayDelayMs(): number {
  return _displayDelayMs;
}

/** Where the slewed delay is heading (wall ms, clamped to the floor/ceiling). */
export function getSwarmDisplayDelayTargetMs(): number {
  return _displayDelayTargetMs;
}

export interface InterpolatedPose {
  x: number;
  y: number;
  angle: number;
}

/** Wraps (a − b) to [−π, π] so we always lerp the short way around. */
function shortestArc(target: number, source: number): number {
  let d = target - source;
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Module-scope scratch for the populated-entries gather (plan:
 * quirky-rabbit, Phase 5). Pre-Phase-5 the function allocated a fresh
 * `PoseRingEntry[]` AND called `Array.prototype.sort` per drone per
 * frame; at ~5-10 in-interest drones × 90 fps on a 90 Hz phone that's
 * ~450-900 small arrays/sec plus a sort temp per call.
 *
 * Single-threaded JS + once-per-frame-per-drone call shape means
 * sharing this scratch across all `interpolateSwarmPose` callers is
 * safe — no reentrancy, no overlap. The scratch holds at most
 * `POSE_RING_DEPTH` references; subsequent calls overwrite them in
 * place. The referenced `PoseRingEntry` instances live on the swarm
 * entry's `poseRing` regardless, so the scratch never retains
 * anything that wouldn't already be live.
 *
 * Sized to `POSE_RING_DEPTH` — load-bearing if that
 * constant changes, the scratch must grow with it (statically
 * verified at the for-loop bound below). */
const _populatedScratch: (PoseRingEntry | null)[] = new Array<PoseRingEntry | null>(POSE_RING_DEPTH).fill(null);

/**
 * Compute the interpolated pose at wall-clock time `nowMs`, with
 * `DISPLAY_DELAY_MS` of buffering. Mutates `out` instead of allocating; pass
 * a per-renderer scratch.
 */
export function interpolateSwarmPose(
  entry: SwarmRenderState,
  nowMs: number,
  out: InterpolatedPose,
): InterpolatedPose {
  // Sleeping entries don't interpolate — they stay parked at the latest pose.
  if (entry.sleeping) {
    out.x = entry.x;
    out.y = entry.y;
    out.angle = entry.angle;
    return out;
  }

  const ring = entry.poseRing;
  // Collect populated entries in `arrivalMs`-ascending order via an
  // in-place insertion sort during fill (zero allocation, beats
  // `Array.prototype.sort` for n ≤ POSE_RING_DEPTH which uses an
  // intermediate buffer + comparator closure).
  let count = 0;
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    const e = ring[i];
    if (!e || e.empty) continue;
    // Insertion sort: shift larger arrivalMs entries right until the
    // insertion slot is reached.
    let j = count;
    while (j > 0 && _populatedScratch[j - 1]!.arrivalMs > e.arrivalMs) {
      _populatedScratch[j] = _populatedScratch[j - 1]!;
      j--;
    }
    _populatedScratch[j] = e;
    count++;
  }

  if (count === 0) {
    // No arrivals yet — should be unreachable because the decoder seeds slot 0
    // on first sighting, but be defensive.
    out.x = entry.x;
    out.y = entry.y;
    out.angle = entry.angle;
    return out;
  }

  const targetMs = nowMs - _displayDelayMs;
  const newest = _populatedScratch[count - 1]!;
  // W2c — an NPC on its warp run or just dropped out: show where it IS. Through
  // the display delay it slid in from its in-flight poses (a fleet arriving
  // ~1 km east of its landing spot, then gliding into place).
  if (entry.warp === 2 || entry.warp === 3) {
    out.x = newest.x;
    out.y = newest.y;
    out.angle = newest.angle;
    return out;
  }
  const oldest = _populatedScratch[0]!;
  _lastReadTargetMs = targetMs;
  if (count > 1) {
    if (targetMs < oldest.arrivalMs) { if (count === POSE_RING_DEPTH) _oldEndClampCount++; }
    else if (targetMs - newest.arrivalMs > glideLimitWallMs()) _glideLimitCount++;
  }

  // Single arrival or render time before our oldest sample: pin to oldest
  // pose. Same shape the legacy first-sighting / pre-window branch used.
  if (count === 1 || targetMs <= oldest.arrivalMs) {
    out.x = oldest.x;
    out.y = oldest.y;
    out.angle = oldest.angle;
    return out;
  }

  // Render time past the newest arrival: dead-reckon with vx/vy AND angvel
  // up to EXTRAPOLATION_LIMIT_MS (game ms; ÷ speed in wall ms), then freeze. Gliding the angle by
  // `angvel·dt` (not freezing it) matters post-pivot: out-of-interest
  // decimated drones (≈100–170 ms cadence) frequently render in this
  // extrapolation window, and a maneuvering drone is usually turning —
  // freezing the angle then snapping it on the next decimated packet reads
  // as a turret/heading "stutter". Wire-format v3 carries `angvel`, the
  // decoder populates every ring slot, so this is a free glide. Without
  // the position dead-reckon the sprite snaps backward through the buffer
  // when arrivals stall briefly.
  if (targetMs >= newest.arrivalMs) {
    const overshootMs = Math.min(glideLimitWallMs(), targetMs - newest.arrivalMs);
    // v is per GAME second: the wall overshoot × speed is the game time glided
    // (S4-1b). The limit above is already ÷ speed, so this caps at 250 game ms.
    const dt = overshootMs * _displaySpeed / 1000;
    out.x = newest.x + newest.vx * dt;
    out.y = newest.y + newest.vy * dt;
    out.angle = newest.angle + newest.angvel * dt;
    return out;
  }

  // Interpolation window — find the two adjacent populated entries `a, b`
  // such that a.arrivalMs ≤ targetMs < b.arrivalMs. At most POSE_RING_DEPTH
  // items, sorted ascending; linear scan is simpler than binary search
  // and unmeasurably faster at this size.
  let a: PoseRingEntry = oldest;
  let b: PoseRingEntry = _populatedScratch[1]!;
  for (let i = 0; i < count - 1; i++) {
    const lo = _populatedScratch[i]!;
    const hi = _populatedScratch[i + 1]!;
    if (targetMs >= lo.arrivalMs && targetMs < hi.arrivalMs) {
      a = lo;
      b = hi;
      break;
    }
  }

  const span = b.arrivalMs - a.arrivalMs;

  // Teleport guard: if the bracketing poses are further apart than any entity
  // could plausibly have moved in `span`, this is a server discontinuity
  // (keyframe / SET_POSITION / id-reuse / sleep→wake), not motion. Snap to the
  // newer authoritative pose — never animate across the gap.
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  if (isImplausibleJump(gap, span)) {
    out.x = b.x;
    out.y = b.y;
    out.angle = b.angle;
    return out;
  }

  const t = span > 0 ? Math.max(0, Math.min(1, (targetMs - a.arrivalMs) / span)) : 0;
  const dAngle = shortestArc(b.angle, a.angle);
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.angle = a.angle + dAngle * t;
  return out;
}
