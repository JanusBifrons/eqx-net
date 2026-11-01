/**
 * Critically-damped spring step (the Game Programming Gems 4 / Unity
 * `SmoothDamp` approximation). Moves `current` toward `target` with no
 * overshoot, reaching it in roughly `smoothTimeMs`. Framerate-independent.
 *
 * Velocity is carried in a caller-owned `state` object so the step is
 * alloc-free (invariant #14 — called every Pixi ticker frame by `Camera.tick`).
 */
export interface DampState {
  /** Units per millisecond. */
  v: number;
}

export function smoothDamp(
  current: number,
  target: number,
  state: DampState,
  smoothTimeMs: number,
  dtMs: number,
): number {
  if (smoothTimeMs <= 0 || dtMs <= 0) {
    state.v = 0;
    return dtMs <= 0 ? current : target;
  }
  const omega = 2 / smoothTimeMs;
  const x = omega * dtMs;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (state.v + omega * change) * dtMs;
  state.v = (state.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  // Overshoot guard: if we crossed the target this step, land on it.
  if ((target - current > 0) === (out > target)) {
    out = target;
    state.v = 0;
  }
  return out;
}
