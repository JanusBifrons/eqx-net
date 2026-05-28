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

/** Teleport guard (drone snapshot-interpolation pivot, 2026-05-18).
 *
 * Routing drones through `interpolateSwarmPose` exposed a streak the old
 * predWorld path masked (instantaneous `setShipState`): a server-side
 * discontinuity — full-snapshot keyframe (`FULL_SNAPSHOT_INTERVAL_TICKS=60`,
 * once/sec), `SET_POSITION`, swarm despawn+entityId-reuse, sleep→wake — lands
 * as two adjacent ring poses thousands of units apart. The unconditional lerp
 * animated the sprite ACROSS that gap over the bracket window (the drone
 * "flies across the sector"). When the gap between the two bracketing poses
 * exceeds what a real entity could plausibly travel in that span, we are
 * looking at a teleport, not motion — SNAP to the newer authoritative pose
 * instead of interpolating. `MAX_PLAUSIBLE_SPEED` sits comfortably above any
 * ship/drone top speed (post-slow-down ~950 u/s); the floor catches
 * short-span jumps where `speed × span` underflows. */
export const TELEPORT_MAX_PLAUSIBLE_SPEED = 2500; // u/s — well above any entity
export const TELEPORT_FLOOR_U = 64; // absolute floor for tiny spans

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

/** Module-level adaptive delay, updated by ColyseusClient on every snapshot
 *  via `setSwarmDisplayDelayMs()`. Default is the static 100 ms; under slow
 *  server (e.g. burn-test or production overload) this floats up so the
 *  buffer never empties. */
let _displayDelayMs = DISPLAY_DELAY_MS;

/** Let the snapshot consumer steer the buffer's lookback window. Call with
 *  the rolling EWMA of `snapshotIntervalMs` × ADAPTIVE_DELAY_FACTOR. */
export function setSwarmDisplayDelayMs(ms: number): void {
  _displayDelayMs = Math.max(DISPLAY_DELAY_MS, Math.min(ADAPTIVE_DELAY_CEILING_MS, ms));
}

export function getSwarmDisplayDelayMs(): number {
  return _displayDelayMs;
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
 * Sized to `POSE_RING_DEPTH` (currently 10) — load-bearing if that
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
  const oldest = _populatedScratch[0]!;

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
  const maxPlausible = Math.max(
    TELEPORT_FLOOR_U,
    (TELEPORT_MAX_PLAUSIBLE_SPEED * Math.max(0, span)) / 1000,
  );
  if (gap > maxPlausible) {
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
