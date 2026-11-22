/** Longest dead-reckon (ms, ~2 ticks): stops wild extrapolation across a
 *  stall. Measured from the due time, a frame needs at most one tick (< F). */
export const DEAD_RECKON_CAP_MS = 32;
/** How far back (ms, one tick) the drawn pose may sit behind the latest
 *  state, when that state's tick fell due after the frame's timestamp. */
export const DEAD_RECKON_BACK_MS = 1000 / 60;

/**
 * Game ms a frame draws past the latest predicted physics state: frame time
 * minus the due time that state stands for (`lastLocalTickAtMs`), clamped to
 * [-DEAD_RECKON_BACK_MS, DEAD_RECKON_CAP_MS]; 0 before the first tick. Every
 * predWorld body the input loop steps (the local ship, remote ships) draws at
 * `state + velocity × this`, so a frame that runs no tick (90 Hz display, 60 Hz
 * physics) still moves the ship. Lock: `gapSmoothing.remoteShips.test.ts`.
 */
export function renderTickElapsedMs(lastLocalTickAtMs: number, frameGameMs: number): number {
  return lastLocalTickAtMs >= 0
    ? Math.max(-DEAD_RECKON_BACK_MS, Math.min(DEAD_RECKON_CAP_MS, frameGameMs - lastLocalTickAtMs))
    : 0;
}

/**
 * When a predicted physics tick boundary was DUE on the wall clock.
 *
 * `tickPhysics` is wall-clock anchored: tick `i` falls due at
 * `anchorPerfNow + (i − anchorServerTick − leadTicks) × fixedMs`, and a frame
 * runs every tick that has fallen due. The local ship's drawn pose is the
 * latest predicted state extrapolated by velocity × (now − the time that
 * state stands for). That time is the due time of the boundary the state sits
 * on, NOT the moment the tick happened to be processed.
 *
 * Stamping the processing time (the pre-2026-11-05 code) made the drawn ship
 * judder whenever the display and the tick grid drifted in and out of phase:
 * a frame that ran 2 ticks drew the ship a tick ahead of real time (its
 * extrapolation was 0), the next 0-tick frame extrapolated a further tick,
 * and the frame after that barely moved: a step-stall several times a second
 * (user, round 3 fly-by clip: "jittering around everywhere"). From the due
 * time, the drawn pose is continuous however the ticks fall into frames.
 */
export function tickBoundaryDueMs(
  anchorPerfNow: number,
  anchorServerTick: number,
  leadTicks: number,
  boundaryTick: number,
  fixedMs: number,
): number {
  return anchorPerfNow + (boundaryTick - anchorServerTick - leadTicks) * fixedMs;
}

/** Most the render due time may move toward the anchor's due time per tick
 *  (ms): 0.5 ms a tick = 30 ms/s, enough for real clock drift, invisible
 *  as motion (0.5 ms of velocity is a few hundredths of a unit). */
export const RENDER_DUE_SLEW_MS = 0.5;
/** Past this gap the render due time snaps (a stall, a hard anchor snap). */
export const RENDER_DUE_SNAP_MS = 200;

/** Times `slewTickDue` snapped (gap > snapMs) instead of slewing.
 *  Diagnostic only: tells whether the 200 ms render snap fires on a real link. */
let renderDueSnapCount = 0;

/** How many render due-time snaps `slewTickDue` has taken since the last reset. */
export function getRenderDueSnapCount(): number {
  return renderDueSnapCount;
}

/** Zero the render-snap counter. Call where the render due time itself is
 *  reset (`resetPredictionState` sets `lastLocalTickAtMs = -1`). */
export function resetRenderDueSnapCount(): void {
  renderDueSnapCount = 0;
}

/**
 * The due time the local ship's drawn pose dead-reckons from, advanced one
 * tick per processed tick and SLEWED toward `targetDueMs` (the anchor-based
 * `tickBoundaryDueMs`), at most `slewMs` per tick.
 *
 * Why: the anchor is an EWMA of snapshot arrival times, so a late snapshot
 * moves it (a 166 ms gap moved it ~16 ms = one tick). Dead-reckoning straight
 * from it drew the ship a tick off until the anchor recovered: the
 * one-tick lurch seen in about half the round-3 / Phase 0 clips. Network
 * timing belongs to the tick schedule, not to where the ship is drawn.
 */
export function slewTickDue(prevDueMs: number, targetDueMs: number, fixedMs: number, slewMs: number, snapMs: number): number {
  const next = prevDueMs + fixedMs;
  const err = targetDueMs - next;
  if (Math.abs(err) > snapMs) { renderDueSnapCount++; return targetDueMs; }
  return next + Math.max(-slewMs, Math.min(slewMs, err));
}
