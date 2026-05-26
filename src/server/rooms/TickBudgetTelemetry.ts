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

const TICK_HITCH_THRESHOLD_MS = 12;
const TICK_HITCH_MIN_INTERVAL_MS = 250;

export interface TickEndContext {
  serverTick: number;
  workerTickMs: number;
  playerCount: number;
  swarmCount: number;
  aiSize: number;
  liveProjectileCount: number;
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

  private lastTickHitchAtMs = 0;
  private tickStart = 0;
  private phaseAnchor = 0;

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
    if (this.tickBudgetSampleCount >= 60) {
      const avg: Record<string, number> = {};
      for (const k of Object.keys(this.tickBudgetSums)) {
        avg[k] = parseFloat((this.tickBudgetSums[k]! / this.tickBudgetSampleCount).toFixed(3));
      }
      serverLogEvent('tick_budget', {
        serverTick: ctx.serverTick,
        sampleCount: this.tickBudgetSampleCount,
        avgMs: avg,
        maxTotalMs: parseFloat(this.tickBudgetMaxTotalMs.toFixed(3)),
        overBudgetCount: this.tickBudgetOverBudgetCount,
        playerCount: ctx.playerCount,
        swarmCount: ctx.swarmCount,
        aiSize: ctx.aiSize,
      });
      for (const k of Object.keys(this.tickBudgetSums)) this.tickBudgetSums[k] = 0;
      this.tickBudgetSampleCount = 0;
      this.tickBudgetMaxTotalMs = 0;
      this.tickBudgetOverBudgetCount = 0;
    }
    return totalMs;
  }
}
