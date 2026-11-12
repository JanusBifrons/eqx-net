/**
 * Tick-budget telemetry — accumulates per-phase wall-clock per tick,
 * emits a `tick_hitch` event for outlier ticks, and aggregates a
 * `tick_budget` average every 60 ticks.
 *
 * Lifted out of `SectorRoom` because it's a self-contained
 * instrumentation concern that owns its own counter state:
 *
 *   - `tickBudgetSums` (cumulative per-phase ms over the current ~60-tick
 *     window) + `tickBudgetSampleCount` + `tickBudgetMaxTotalMs` +
 *     `tickBudgetOverBudgetCount`. Aggregated and emitted as one
 *     `tick_budget` event per second, then reset.
 *
 *   - `thisTickPhases` — per-tick breakdown reset at the top of each
 *     `update()`. Written by `phaseTime(key)` after each phase. Read
 *     by the hot-capture branch when totalMs > TICK_HITCH_THRESHOLD_MS
 *     (~12 ms). Answers "which subsystem ate the time on THIS tick" —
 *     the aggregated tick_budget averages can't.
 *
 *   - `tickHistoryRing` — 3-tick rolling history of (tick, totalMs,
 *     phases). Included on each `tick_hitch` event so the consumer can
 *     see whether the hitch is isolated or part of a cluster.
 *
 *   - Hitch rate-limit (~250 ms) so a sustained pathology doesn't
 *     flood the server-event buffer; cluster context still surfaces
 *     via `recentTicks` on the next admitted hitch.
 *
 * The class owns the state; `SectorRoom.update()` calls `beginTick()`
 * at top, `phaseTime(key)` at each seam, and `endTick(...)` at the
 * bottom (which fires the hitch event if applicable, pushes to the
 * history ring, and emits the aggregated `tick_budget` once per ~60
 * ticks).
 */

import { serverLogEvent } from '../debug/ServerEventLog.js';

export const TICK_HITCH_THRESHOLD_MS = 12;
export const TICK_HITCH_MIN_INTERVAL_MS = 250;
export const SAMPLE_EMIT_CADENCE = 60;

export interface TickEndContext {
  serverTick: number;
  workerTickMs: number;
  playerCount: number;
  swarmCount: number;
  aiSize: number;
  liveProjectileCount: number;
  /** The physics worker's tick counter (SAB `TICK_IDX`): game time. Optional
   *  so unit callers without a worker skip the lateness fields. */
  workerTick?: number;
  /** Cumulative ticks the worker's catch-up cap dropped (SAB
   *  `WORKER_DROPPED_TICKS_IDX`). */
  workerDroppedTicks?: number;
  /** The sector's game speed: real time allows 60 × this ticks per second.
   *  Default 1. */
  timeScale?: number;
}

/**
 * Game time against wall time over one `tick_budget` window (game time
 * scale, Phase 1). `wallTicks` is how many ticks real time allowed at the sector's game speed (60 × speed per second);
 * `simTicks` is how many the physics worker ran. `latenessTicks` =
 * wall − sim: how far the game fell behind real time in the window, the
 * starved-host signal tick COST misses (a late tick can be a cheap one).
 * `droppedTicks` is the part the worker's catch-up cap threw away.
 */
export interface SimLateness {
  wallTicks: number;
  simTicks: number;
  latenessTicks: number;
  droppedTicks: number;
}

export class TickBudgetTelemetry {
  private readonly tickBudgetSums: Record<string, number> = {
    sabRead: 0,
    projectiles: 0,
    swarmEncode: 0,
    swarmBroadcast: 0,
    snapshotBroadcast: 0,
    aiTick: 0,
    aiFire: 0,
    total: 0,
  };
  private tickBudgetSampleCount = 0;
  private tickBudgetMaxTotalMs = 0;
  private tickBudgetOverBudgetCount = 0;

  private readonly thisTickPhases: Record<string, number> = {};
  private readonly tickHistoryRing: Array<{
    tick: number;
    totalMs: number;
    phases: Record<string, number>;
  }> = [];

  // -Infinity (not 0) so the FIRST hitch always clears the cooldown
  // gate. `performance.now()` is relative to the worker/process time
  // origin, so in a freshly-started worker `nowMs` can be < the 250 ms
  // interval — initialising to 0 made `nowMs - 0 >= 250` false and
  // silently dropped a sector's first-ever hitch (and flaked the unit
  // test on fast CI workers, green-local / red-CI).
  private lastTickHitchAtMs = Number.NEGATIVE_INFINITY;
  private tickStart = 0;
  private phaseAnchor = 0;

  // Lateness window (game time vs wall time), re-anchored at every emit.
  private windowStartMs = Number.NaN;
  private windowStartWorkerTick = 0;
  private windowStartDropped = 0;
  private readonly lastLateness: SimLateness = {
    wallTicks: 0, simTicks: 0, latenessTicks: 0, droppedTicks: 0,
  };

  /** The most recent window's lateness (zeros until the first window ends).
   *  Shared object, overwritten in place each window. */
  lateness(): Readonly<SimLateness> { return this.lastLateness; }

  /** Call at the very top of update(). */
  beginTick(tStart: number): void {
    this.tickStart = tStart;
    this.phaseAnchor = tStart;
    for (const k of Object.keys(this.thisTickPhases)) this.thisTickPhases[k] = 0;
  }

  /** Call after each phase; key is the phase name (e.g. 'sabRead'). */
  phaseTime(key: string): void {
    const now = performance.now();
    const elapsed = now - this.phaseAnchor;
    this.tickBudgetSums[key] = (this.tickBudgetSums[key] ?? 0) + elapsed;
    this.thisTickPhases[key] = (this.thisTickPhases[key] ?? 0) + elapsed;
    this.phaseAnchor = now;
  }

  /**
   * Call at the very end of update(). Returns the totalMs for this
   * tick so the caller can hand it to the TiDi `simClock.report`
   * (which feeds into LoadShedder).
   */
  endTick(ctx: TickEndContext): number {
    const totalMs = performance.now() - this.tickStart;
    if (Number.isNaN(this.windowStartMs)) this.anchorLatenessWindow(this.tickStart, ctx);
    this.tickBudgetSums['total'] = (this.tickBudgetSums['total'] ?? 0) + totalMs;
    this.tickBudgetSampleCount++;
    if (totalMs > this.tickBudgetMaxTotalMs) this.tickBudgetMaxTotalMs = totalMs;
    if (totalMs > 16.67) this.tickBudgetOverBudgetCount++;

    // Hot-capture single-tick hitches. Rate-limited so a sustained
    // pathology doesn't flood the server-event buffer.
    const nowMs = performance.now();
    if (
      totalMs > TICK_HITCH_THRESHOLD_MS &&
      nowMs - this.lastTickHitchAtMs >= TICK_HITCH_MIN_INTERVAL_MS
    ) {
      this.lastTickHitchAtMs = nowMs;
      const phasesSnapshot: Record<string, number> = {};
      for (const k of Object.keys(this.thisTickPhases)) {
        phasesSnapshot[k] = parseFloat((this.thisTickPhases[k] ?? 0).toFixed(3));
      }
      phasesSnapshot['total'] = parseFloat(totalMs.toFixed(3));
      serverLogEvent('tick_hitch', {
        serverTick: ctx.serverTick,
        totalMs: parseFloat(totalMs.toFixed(3)),
        phases: phasesSnapshot,
        recentTicks: this.tickHistoryRing.slice(),
        workerTickMs: parseFloat(ctx.workerTickMs.toFixed(3)),
        playerCount: ctx.playerCount,
        swarmCount: ctx.swarmCount,
        aiSize: ctx.aiSize,
        liveProjectileCount: ctx.liveProjectileCount,
      });
    }
    // Maintain the rolling 3-tick history regardless of hitch — context
    // for the next hitch event.
    this.tickHistoryRing.push({
      tick: ctx.serverTick,
      totalMs: parseFloat(totalMs.toFixed(3)),
      phases: { ...this.thisTickPhases },
    });
    if (this.tickHistoryRing.length > 3) this.tickHistoryRing.shift();

    // Aggregated tick_budget once per ~60 ticks (= 1 s @ 60 Hz).
    if (this.tickBudgetSampleCount >= SAMPLE_EMIT_CADENCE) {
      const avg: Record<string, number> = {};
      for (const k of Object.keys(this.tickBudgetSums)) {
        avg[k] = parseFloat((this.tickBudgetSums[k]! / this.tickBudgetSampleCount).toFixed(3));
      }
      const late = this.closeLatenessWindow(nowMs, ctx);
      serverLogEvent('tick_budget', {
        serverTick: ctx.serverTick,
        sampleCount: this.tickBudgetSampleCount,
        avgMs: avg,
        maxTotalMs: parseFloat(this.tickBudgetMaxTotalMs.toFixed(3)),
        overBudgetCount: this.tickBudgetOverBudgetCount,
        playerCount: ctx.playerCount,
        swarmCount: ctx.swarmCount,
        aiSize: ctx.aiSize,
        ...(late ? {
          wallTicks: late.wallTicks,
          simTicks: late.simTicks,
          latenessTicks: late.latenessTicks,
          droppedTicks: late.droppedTicks,
        } : {}),
      });
      for (const k of Object.keys(this.tickBudgetSums)) this.tickBudgetSums[k] = 0;
      this.tickBudgetSampleCount = 0;
      this.tickBudgetMaxTotalMs = 0;
      this.tickBudgetOverBudgetCount = 0;
    }
    return totalMs;
  }

  private anchorLatenessWindow(nowMs: number, ctx: TickEndContext): void {
    this.windowStartMs = nowMs;
    this.windowStartWorkerTick = ctx.workerTick ?? 0;
    this.windowStartDropped = ctx.workerDroppedTicks ?? 0;
  }

  /** Close the window at `nowMs`, store its lateness, re-anchor. Returns
   *  null when the caller has no worker tick (unit callers). */
  private closeLatenessWindow(nowMs: number, ctx: TickEndContext): SimLateness | null {
    if (ctx.workerTick === undefined) return null;
    const out = this.lastLateness;
    out.wallTicks = Math.round(((nowMs - this.windowStartMs) * 60 * (ctx.timeScale ?? 1)) / 1000);
    // u32 counters: `>>> 0` keeps a wrap from going negative.
    out.simTicks = (ctx.workerTick - this.windowStartWorkerTick) >>> 0;
    out.droppedTicks = ((ctx.workerDroppedTicks ?? 0) - this.windowStartDropped) >>> 0;
    out.latenessTicks = out.wallTicks - out.simTicks;
    this.anchorLatenessWindow(nowMs, ctx);
    return out;
  }
}
