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

/** Maximum dead-reckoning window past the newest arrival before freezing. */
export const EXTRAPOLATION_LIMIT_MS = 100;

/** Teleport guard (drone snapshot-interpolation pivot, 2026-05-18): routing
 * drones through `interpolateSwarmPose` exposed server discontinuities that
 * the unconditional lerp animated across. The bound and its rationale live in
 * `plausibleSpeed.ts` (one definition, shared with the other-ship snap);
 * re-exported here so existing importers keep working. */
export { TELEPORT_MAX_PLAUSIBLE_SPEED, TELEPORT_FLOOR_U } from './plausibleSpeed.js';

/** How aggressively the adaptive delay tracks observed inter-arrival times.
 *  1.5× means the buffer always has half an arrival of headroom past the
 *  display target, so a single late packet never empties the lerp window. */
export const ADAPTIVE_DELAY_FACTOR = 1.5;

/** Hard ceiling on adaptive delay — past this the perceived latency starts
 *  to feel unresponsive even if motion is smooth. Raised 200 → 280 for the
 *  drone snapshot-interpolation pivot (Step 4, 2026-05-18): an
 *  out-of-interest / decimated drone arrives every `DECIMATION_TICKS≈6`
 *  ticks ≈ 100–170 ms; the adaptive feed sizes the delay at
 *  `binaryInterArrivalEwma × ADAPTIVE_DELAY_FACTOR` (≈ 1.5×), so a 170 ms
 *  decimated cadence wants ~255 ms of buffer to still have two bracketing
 *  samples. 280 leaves headroom above that without feeling unresponsive
 *  for the combat pack (which is in-interest at ~per-tick cadence and sits
 *  near the 100 ms floor, nowhere near this ceiling). Distant decimated
 *  drones accept the added latency by design — they are not the threat;
 *  the teleport guard covers the in↔out re-acquire. */
export const ADAPTIVE_DELAY_CEILING_MS = 280;

/** Module-level adaptive delay: the SLEWED value every read uses (netcode gap
 *  smoothing S3-2). `setSwarmDisplayDelayMs()` (fed by `snapshotPerfStats` on
 *  every snapshot) sets `_displayDelayTargetMs`; `stepSwarmDisplayDelay()`
 *  (once per frame, `updateSwarmMirror`) moves this value toward it, so a
 *  changed target glides instead of jumping the read point. Default is the
 *  static 100 ms; under slow server (burn-test, production overload) the
 *  target floats up so the buffer never empties. */
let _displayDelayMs = DISPLAY_DELAY_MS;
/** Where the slewed delay is heading (wall ms, already clamped). */
let _displayDelayTargetMs = DISPLAY_DELAY_MS;
/** False until the first `setSwarmDisplayDelayMs` after a reset: that first
 *  set places the value AT its target (no glide up from the floor). */
let _displayDelaySeeded = false;
/** The sector's game speed (time scale stream). The floor and ceiling are GAME
 *  ms, so in wall ms they are 100 / speed and 280 / speed: at 4× poses arrive
 *  4× as often and 25 wall ms still spans the same few of them (a fixed 100 ms
 *  would reach past `POSE_RING_DEPTH` and pin drones to a stale pose); at
 *  0.25× the buffer stretches to cover the slower arrivals. */
let _displaySpeed = 1;
let _lastDelayInputMs = DISPLAY_DELAY_MS;

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

function clampDisplayDelayWallMs(ms: number): number {
  return Math.max(DISPLAY_DELAY_MS / _displaySpeed, Math.min(ADAPTIVE_DELAY_CEILING_MS / _displaySpeed, ms));
}

/** Let the snapshot consumer steer the buffer's lookback window. Call with
 *  the rolling EWMA of `snapshotIntervalMs` × ADAPTIVE_DELAY_FACTOR (wall ms).
 *  Sets the TARGET; the value glides there in `stepSwarmDisplayDelay`
 *  (the first call after a reset places the value at the target). */
export function setSwarmDisplayDelayMs(ms: number): void {
  _lastDelayInputMs = ms;
  _displayDelayTargetMs = clampDisplayDelayWallMs(ms);
  if (!_displayDelaySeeded) {
    _displayDelaySeeded = true;
    _displayDelayMs = _displayDelayTargetMs;
  }
}

/** Move the delay toward its target by one frame of `frameDtMs` wall ms:
 *  proportional to the remaining gap, bounded to
 *  `DISPLAY_DELAY_SLEW_MAX_RATE × frameDtMs` either way. Call once per frame
 *  (`updateSwarmMirror`). Scalars only. */
export function stepSwarmDisplayDelay(frameDtMs: number): void {
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

/** Put the delay back at the floor with no target and no lateness estimate
 *  (sector change: `resetPredictionState`; tests: `resetSwarmTickClock`).
 *  The next `setSwarmDisplayDelayMs` places the value at its target. */
export function resetSwarmDisplayDelay(): void {
  _lastDelayInputMs = DISPLAY_DELAY_MS;
  _displayDelayTargetMs = clampDisplayDelayWallMs(DISPLAY_DELAY_MS);
  _displayDelayMs = _displayDelayTargetMs;
  _displayDelaySeeded = false;
  _latenessEstimate.estimateMs = 0;
  _latenessEstimate.deviationMs = 0;
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

/** One server tick in game ms (the room steps at 60 Hz game time). */
const SERVER_TICK_MS = 1000 / 60;
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
/** Reads past the newest pose by more than EXTRAPOLATION_LIMIT_MS (frozen at
 *  the glide limit). Counted per entity per frame. */
let _glideLimitCount = 0;
/** The read point: the target time of the latest interpolation read. NaN
 *  until the first read, so no overwrite counts before anything was read. */
let _lastReadTargetMs = Number.NaN;

// Drone lateness estimate (netcode gap smoothing, S3-1). Smoothed per-packet
// lateness (the S0-2 `lateMs` above) plus its mean absolute deviation (RFC
// 6298 style). Read-only for now: it drives NO delay, ring, playback or pose.
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

const _latenessEstimate: LatenessEstimate = { estimateMs: 0, deviationMs: 0 };

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
  } else {
    _tickClockOffsetMs += (cand - _tickClockOffsetMs) * TICK_CLOCK_DRIFT_UP;
  }
  const stamp = Math.min(nowMs, tick * tickWallMs + _tickClockOffsetMs);
  const lateMs = nowMs - stamp;
  _latenessLastMs = lateMs;
  if (lateMs > _latenessMaxMs) _latenessMaxMs = lateMs;
  _latenessSumMs += lateMs;
  _latenessCount++;
  updateLatenessEstimate(_latenessEstimate, lateMs);
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
/** Smoothed drone packet lateness (wall ms). Read-only; drives nothing yet. */
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
    else if (targetMs - newest.arrivalMs > EXTRAPOLATION_LIMIT_MS) _glideLimitCount++;
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
  // up to EXTRAPOLATION_LIMIT_MS, then freeze. Gliding the angle by
  // `angvel·dt` (not freezing it) matters post-pivot: out-of-interest
  // decimated drones (≈100–170 ms cadence) frequently render in this
  // extrapolation window, and a maneuvering drone is usually turning —
  // freezing the angle then snapping it on the next decimated packet reads
  // as a turret/heading "stutter". Wire-format v3 carries `angvel`, the
  // decoder populates every ring slot, so this is a free glide. Without
  // the position dead-reckon the sprite snaps backward through the buffer
  // when arrivals stall briefly.
  if (targetMs >= newest.arrivalMs) {
    const overshootMs = Math.min(EXTRAPOLATION_LIMIT_MS, targetMs - newest.arrivalMs);
    const dt = overshootMs / 1000;
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
