/**
 * Time-based entity interpolation for swarm sprites.
 *
 * Given an entry's `prev*` and latest pose plus arrival timestamps, returns
 * the lerped pose at wall-clock time `nowMs`. Two regimes:
 *   - Inside the inter-packet window: linear interpolation prev → latest.
 *   - Past `latestArrivalMs`: extrapolate with `vx/vy` for up to
 *     `EXTRAPOLATION_LIMIT_MS`, then freeze.
 *
 * Angle is wrapped to the shortest arc so a +π → −π transition doesn't
 * spin the sprite the long way around.
 */
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';

/** Maximum extrapolation window (ms). Past this we freeze at the latest pose. */
export const EXTRAPOLATION_LIMIT_MS = 100;

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
 * Compute the interpolated pose at wall-clock time `nowMs`. Mutates the
 * passed `out` object instead of allocating; pass a per-renderer scratch.
 */
export function interpolateSwarmPose(
  entry: SwarmRenderState,
  nowMs: number,
  out: InterpolatedPose,
): InterpolatedPose {
  const { prevX, prevY, prevAngle, prevArrivalMs, latestArrivalMs } = entry;

  // Sleeping entries don't interpolate — they stay parked at the latest pose.
  if (entry.sleeping) {
    out.x = entry.x;
    out.y = entry.y;
    out.angle = entry.angle;
    return out;
  }

  // First-sighting case: prev == latest, no window. Render the latest pose.
  if (latestArrivalMs <= prevArrivalMs) {
    out.x = entry.x;
    out.y = entry.y;
    out.angle = entry.angle;
    return out;
  }

  if (nowMs <= latestArrivalMs) {
    // Interpolation window: nowMs is between prev and latest arrivals.
    const t = Math.max(0, Math.min(1, (nowMs - prevArrivalMs) / (latestArrivalMs - prevArrivalMs)));
    const dAngle = shortestArc(entry.angle, prevAngle);
    out.x = prevX + (entry.x - prevX) * t;
    out.y = prevY + (entry.y - prevY) * t;
    out.angle = prevAngle + dAngle * t;
    return out;
  }

  // Past the latest arrival: extrapolate with vx/vy for up to EXTRAPOLATION_LIMIT_MS.
  const overshootMs = nowMs - latestArrivalMs;
  if (overshootMs >= EXTRAPOLATION_LIMIT_MS) {
    out.x = entry.x + entry.vx * (EXTRAPOLATION_LIMIT_MS / 1000);
    out.y = entry.y + entry.vy * (EXTRAPOLATION_LIMIT_MS / 1000);
    out.angle = entry.angle;
    return out;
  }
  const dt = overshootMs / 1000;
  out.x = entry.x + entry.vx * dt;
  out.y = entry.y + entry.vy * dt;
  out.angle = entry.angle;
  return out;
}
