/**
 * The speed dimmer, shared by server and client (time scale stream; #15: one
 * definition, so both sides glide identically).
 *
 * A sector's speed glides toward its target at `TIME_SCALE_SLEW_PER_S` speed
 * units per wall second. The server steps its clock with `glideToward` every
 * update; the client, which hears the speed only through snapshots, uses the
 * same function to EXTRAPOLATE where the server's speed is now (the last
 * keyframe's speed + target, moved on by the time since it arrived plus half
 * the round trip). Without that, the client's clock lags the server's through
 * a glide and every late input shows as a prediction correction (measured:
 * 16–17 corrections per 1×→0.4×→2× take).
 */

/** Speed units per wall second: 1× → 0.5× in 1 s, 1× → 2× in 2 s. */
export const TIME_SCALE_SLEW_PER_S = 0.5;

/** `from` moved toward `to` by at most `TIME_SCALE_SLEW_PER_S × dtSec`. */
export function glideToward(from: number, to: number, dtSec: number): number {
  const step = TIME_SCALE_SLEW_PER_S * Math.max(0, dtSec);
  if (Math.abs(to - from) <= step) return to;
  return from + Math.sign(to - from) * step;
}
