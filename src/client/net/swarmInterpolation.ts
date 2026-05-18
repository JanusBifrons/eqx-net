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

/** Default / minimum display delay.
 *
 * History:
 *   - Original: 100 ms — generous buffer when arrival jitter measurements
 *     were unknown.
 *   - Stage 0 of the network-feel roadmap: 50 ms — measured jitter ≤ 20 ms
 *     in practice, halved the visible remote-entity lag.
 *   - 2026-05-09 fix (this commit): 0 ms.
 *
 * The 50 ms backward-buffered delay made the *rendered* swarm position
 * lag the *predWorld* swarm position (which is the collision shape) by
 * up to 50 ms × drone-velocity. For a drone moving at 30 u/sec that is
 * ~1.5 u; a fast drone moving at 100 u/sec is 5 u. The user could
 * visually overlap a drone (which looks like a hit) and have the ship
 * pass through, because the collision was against the predWorld drone
 * at a position 5 u further along. Same root cause for hitscan
 * accuracy complaints — the ray geometry is built from rendered
 * positions but server lag-comp uses authoritative ones.
 *
 * With `0 ms` and `interpolateSwarmPose` falling into the
 * "targetMs >= newest.arrivalMs" branch, the renderer reads the
 * latest packet pose plus forward dead-reckoning by `vx*dt` —
 * exactly what predWorld does for dynamic drones (since the
 * 2026-05-09 unlock fix). Render and collision shape now align.
 *
 * Trade-off: any wire-arrival jitter beyond the inter-arrival
 * cadence shows as a small visual snap when the next packet finally
 * lands and corrects the dead-reckoning. With p99 snapshot intervals
 * of ~85 ms (vs nominal 50 ms) the snap on a worst-case packet is
 * ~35 ms × velocity ≈ 1 u for a typical drone — visible only as
 * mild stutter, vastly preferable to the visible-collision mismatch.
 */
export const DISPLAY_DELAY_MS = 0;

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
 *  to feel unresponsive even if motion is smooth. Reached only when the
 *  server is severely behind (e.g. ≤ 10 Hz wall-clock). Stage 0 dropped
 *  this from 350 ms: jitter is stable < 20 ms in practice, so 200 ms is
 *  10× the worst-case buffer width — plenty without being conservative. */
export const ADAPTIVE_DELAY_CEILING_MS = 200;

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
  // Collect populated entries in arrival order. With POSE_RING_DEPTH = 3
  // this is at most 3 items; cheap. We sort by `arrivalMs` ascending so
  // the bracketing search is straightforward regardless of `ringHead`.
  // Allocating a 3-slot scratch each call is fine — JIT inlines it.
  const populated: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    const e = ring[i];
    if (e && !e.empty) populated.push(e);
  }

  if (populated.length === 0) {
    // No arrivals yet — should be unreachable because the decoder seeds slot 0
    // on first sighting, but be defensive.
    out.x = entry.x;
    out.y = entry.y;
    out.angle = entry.angle;
    return out;
  }

  populated.sort((a, b) => a.arrivalMs - b.arrivalMs);

  const targetMs = nowMs - _displayDelayMs;
  const newest = populated[populated.length - 1]!;
  const oldest = populated[0]!;

  // Single arrival or render time before our oldest sample: pin to oldest
  // pose. Same shape the legacy first-sighting / pre-window branch used.
  if (populated.length === 1 || targetMs <= oldest.arrivalMs) {
    out.x = oldest.x;
    out.y = oldest.y;
    out.angle = oldest.angle;
    return out;
  }

  // Render time past the newest arrival: dead-reckon with vx/vy up to
  // EXTRAPOLATION_LIMIT_MS, then freeze. Without this the sprite snaps
  // backwards through the buffer when arrivals stall briefly.
  if (targetMs >= newest.arrivalMs) {
    const overshootMs = Math.min(EXTRAPOLATION_LIMIT_MS, targetMs - newest.arrivalMs);
    const dt = overshootMs / 1000;
    out.x = newest.x + newest.vx * dt;
    out.y = newest.y + newest.vy * dt;
    out.angle = newest.angle;
    return out;
  }

  // Interpolation window — find the two adjacent populated entries `a, b`
  // such that a.arrivalMs ≤ targetMs < b.arrivalMs. With at most 3 items
  // a linear scan is simpler than binary search and unmeasurably faster.
  let a: PoseRingEntry = oldest;
  let b: PoseRingEntry = populated[1]!;
  for (let i = 0; i < populated.length - 1; i++) {
    const lo = populated[i]!;
    const hi = populated[i + 1]!;
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
