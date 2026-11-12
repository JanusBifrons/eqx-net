/**
 * The physics worker's catch-up cap, as a pure step so the ticks it drops can
 * be counted and tested (game time scale, Phase 1 telemetry).
 *
 * After a tick runs, the next one is due one tick later. If the loop is more
 * than `CATCH_UP_MAX_TICKS` behind (a GC pause, a starved host), it does not
 * replay the backlog: it jumps the schedule to "now" and the lost time is
 * dropped. Before this counter, that loss was invisible: the worker kept
 * reporting rate 1.0 while the game ran slower than real time (docs/SHELF.md).
 */

export const CATCH_UP_MAX_TICKS = 5;

/** Reused result (no per-tick allocation, invariant #14). */
export interface CatchUpResult {
  nextTickAt: number;
  /** Whole ticks skipped by this jump (0 when on schedule). */
  dropped: number;
}

/**
 * `nextTickAt` is when the tick that just ran was due. Writes the next due
 * time and the dropped tick count into `out`.
 */
export function advanceSchedule(
  now: number,
  nextTickAt: number,
  tickMs: number,
  out: CatchUpResult,
): CatchUpResult {
  const next = nextTickAt + tickMs;
  if (now > next + CATCH_UP_MAX_TICKS * tickMs) {
    // Ticks due in [next, now] that will never run, minus the one that runs
    // next (due at now + tickMs).
    out.dropped = Math.floor((now - next) / tickMs);
    out.nextTickAt = now + tickMs;
  } else {
    out.dropped = 0;
    out.nextTickAt = next;
  }
  return out;
}
