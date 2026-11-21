/**
 * Phone-lane display-delay window (netcode gap smoothing S5-8): the drone /
 * missile display-delay machinery, recorded into each 10 s `perf_summary` so
 * an on-device capture measures it instead of a simulation.
 *
 * Lane builds only. Per processed frame `sampleLaneDelay` folds the current
 * drone delay into four scalars (count, sum, min, max): no allocation. At the
 * window edge `takeLaneDelayWindow` reads the existing getters and cumulative
 * counters (`swarmInterpolation.ts`, `MissileMirror.ts`), reports the counts
 * since the previous window (a counter that went backwards was reset by a
 * sector change: count from zero then) and restarts the window.
 */

/** One window's running state. Mutated in place; scalars only. */
export interface LaneDelayWindow {
  samples: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  /** Cumulative counters at the previous window edge. */
  holdBefore: number;
  resyncBefore: number;
  glideBefore: number;
  clampBefore: number;
  packetsBefore: number;
  missileHoldBefore: number;
  missileResyncBefore: number;
}

/** The getters' values at a window edge (wall ms; cumulative counters). */
export interface LaneDelayReadings {
  delayMs: number;
  targetMs: number;
  steadyMs: number;
  holdFrames: number;
  resyncs: number;
  glideLimits: number;
  oldEndClamps: number;
  swarmPackets: number;
  /** The missile stream's delay; NaN before the drone timeline seeds. */
  missileDelayMs: number;
  missileHoldFrames: number;
  missileResyncs: number;
}

/** The delay fields one `perf_summary` line carries. */
export interface LaneDelaySummary {
  /** Drone display delay now (wall ms): the slewed, possibly held value reads use. */
  droneDelayMs: number;
  /** Lowest / mean / highest drone delay over the window's frames (null: no frames). */
  droneDelayMinMs: number | null;
  droneDelayMeanMs: number | null;
  droneDelayMaxMs: number | null;
  /** Where the drone delay slews toward (adaptive target, floor/ceiling clamped). */
  droneDelayTargetMs: number;
  /** The drone delay before the stall hold (the slew alone; shells read it). */
  droneSteadyDelayMs: number;
  /** Frames in the window on which a stream stall held the drone read point. */
  droneHoldFrames: number;
  /** Drone re-syncs in the window (a hold that would pass the maximum delay). */
  droneResyncs: number;
  /** Per-drone-per-frame reads capped at the glide limit in the window. */
  droneGlideLimits: number;
  /** Reads clamped to the pose ring's oldest sample in the window. */
  droneOldEndClamps: number;
  /** Binary swarm packets stamped in the window. */
  swarmPackets: number;
  /** Missile stream display delay now (wall ms); null before it seeds. */
  missileDelayMs: number | null;
  /** Frames in the window a JSON stream stall held the missile read point. */
  missileHoldFrames: number;
  /** Missile stream re-syncs in the window. */
  missileResyncs: number;
}

export function createLaneDelayWindow(): LaneDelayWindow {
  return {
    samples: 0, sumMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: Number.NEGATIVE_INFINITY,
    holdBefore: 0, resyncBefore: 0, glideBefore: 0, clampBefore: 0, packetsBefore: 0,
    missileHoldBefore: 0, missileResyncBefore: 0,
  };
}

/** Fold one frame's drone delay in. Hot path: no allocation; non-finite skipped. */
export function sampleLaneDelay(w: LaneDelayWindow, delayMs: number): void {
  if (!Number.isFinite(delayMs)) return;
  w.samples++;
  w.sumMs += delayMs;
  if (delayMs < w.minMs) w.minMs = delayMs;
  if (delayMs > w.maxMs) w.maxMs = delayMs;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
/** Count since `before`; a counter below it was reset, so count from zero. */
const since = (now: number, before: number): number => (now >= before ? now - before : now);

/** The window's summary from `r`; restarts the window (samples and baselines). */
export function takeLaneDelayWindow(w: LaneDelayWindow, r: LaneDelayReadings): LaneDelaySummary {
  const any = w.samples > 0;
  const out: LaneDelaySummary = {
    droneDelayMs: r1(r.delayMs),
    droneDelayMinMs: any ? r1(w.minMs) : null,
    droneDelayMeanMs: any ? r1(w.sumMs / w.samples) : null,
    droneDelayMaxMs: any ? r1(w.maxMs) : null,
    droneDelayTargetMs: r1(r.targetMs),
    droneSteadyDelayMs: r1(r.steadyMs),
    droneHoldFrames: since(r.holdFrames, w.holdBefore),
    droneResyncs: since(r.resyncs, w.resyncBefore),
    droneGlideLimits: since(r.glideLimits, w.glideBefore),
    droneOldEndClamps: since(r.oldEndClamps, w.clampBefore),
    swarmPackets: since(r.swarmPackets, w.packetsBefore),
    missileDelayMs: Number.isFinite(r.missileDelayMs) ? r1(r.missileDelayMs) : null,
    missileHoldFrames: since(r.missileHoldFrames, w.missileHoldBefore),
    missileResyncs: since(r.missileResyncs, w.missileResyncBefore),
  };
  w.samples = 0;
  w.sumMs = 0;
  w.minMs = Number.POSITIVE_INFINITY;
  w.maxMs = Number.NEGATIVE_INFINITY;
  w.holdBefore = r.holdFrames;
  w.resyncBefore = r.resyncs;
  w.glideBefore = r.glideLimits;
  w.clampBefore = r.oldEndClamps;
  w.packetsBefore = r.swarmPackets;
  w.missileHoldBefore = r.missileHoldFrames;
  w.missileResyncBefore = r.missileResyncs;
  return out;
}
