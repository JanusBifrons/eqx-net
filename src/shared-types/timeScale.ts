/**
 * The speed dimmer, shared by server and client (time scale stream; #15: one
 * definition, so both sides glide identically).
 *
 * A sector's speed glides toward its target at a steady RATIO: it doubles or
 * halves at most once per `TIME_SCALE_HALVINGS_PER_S` of wall time, so 1× →
 * 0.5× and 1× → 2× each take 1 s, and 4× → 0.25× takes 4 s, evenly. (A
 * linear glide felt uneven across the range: 4×→1× took 6 s, then 1×→0.25×
 * rushed by in 1.5 s; hostile review 2026-11-12.)
 *
 * The server steps its clock with `glideToward` every update; the client,
 * which hears the speed only through snapshots, uses the same function to
 * EXTRAPOLATE where the server's speed is now (the last keyframe's speed +
 * target, moved on by the time since it arrived plus half the round trip).
 * Without that, the client's clock lags the server's through a glide and
 * every late input shows as a prediction correction.
 */

/** Doublings or halvings per wall second. */
export const TIME_SCALE_HALVINGS_PER_S = 1;

/** `from` moved toward `to` by at most `TIME_SCALE_HALVINGS_PER_S × dtSec`
 *  doublings/halvings (a steady ratio, so the glide feels even at any speed). */
export function glideToward(from: number, to: number, dtSec: number): number {
  if (!(from > 0) || !(to > 0)) return to;
  const step = TIME_SCALE_HALVINGS_PER_S * Math.max(0, dtSec) * Math.LN2;
  const lf = Math.log(from);
  const lt = Math.log(to);
  if (Math.abs(lt - lf) <= step) return to;
  return Math.exp(lf + Math.sign(lt - lf) * step);
}
