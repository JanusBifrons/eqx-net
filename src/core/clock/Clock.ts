/**
 * Wall-clock injection seam — exists so the replay harness can drive a
 * REAL `ColyseusGameClient` through a captured session with controllable
 * time. Without this, `performance.now()` calls scattered across the
 * client are not mockable, the harness can't reconstruct the on-device
 * timeline deterministically, and we're back to re-implementations that
 * miss bugs.
 *
 * Not to be confused with `SimulationClock` (sibling file) — that one is
 * the TiDi rate machine for server-side simulation throttling. THIS
 * module is the wall-clock source for the CLIENT's input loop and the
 * Reconciler's RTT measurement.
 *
 * Production code uses `REAL_CLOCK` (default). Tests inject `MockClock`
 * to advance time on command.
 */

/**
 * The narrowest possible time source. Anything more specific (jitter,
 * sleep, scheduling) is out of scope — those live in their own helpers.
 */
export interface Clock {
  now(): number;
}

/**
 * Default real-time impl. Direct `performance.now()` passthrough — zero
 * production cost (V8 inlines this).
 */
export const REAL_CLOCK: Clock = {
  now: () => performance.now(),
};

/**
 * Test-only clock with manual advancement. Tests construct one, pass it
 * to the production class under test, then call `advance(ms)` to step
 * time forward without spinning a real interval.
 *
 * `t` is exposed for tests that need to assert absolute clock values
 * (e.g., "the welcome anchor was set to the clock's `t` at the moment
 * the welcome handler ran").
 */
export class MockClock implements Clock {
  constructor(public t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
