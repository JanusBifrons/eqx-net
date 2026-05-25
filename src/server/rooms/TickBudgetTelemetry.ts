/**
 * Per-tick performance telemetry for SectorRoom.
 *
 * Owns: phase-time accumulator, hitch detection, rolling 3-tick history,
 * 60-sample aggregated `tick_budget` emit cadence. Step 3 of the hazy-pillow
 * decomposition plan — extracts the timing/budget concern from SectorRoom
 * with no behavioural change.
 *
 * Phase keys: caller-defined strings. The 9 keys SectorRoom uses today
 * (`sabRead`, `projectiles`, `swarmEncode`, `swarmBroadcast`,
 * `snapshotBroadcast`, `aiTick`, `aiFire`, `playerMounts`, `droneMounts`)
 * are preserved exactly so downstream `tick_budget` / `tick_hitch` log
 * consumers stay comparable across the refactor.
 *
 * Lifecycle per tick:
 *   1. `startTick()` — reset per-tick scratch
 *   2. for each phase: `mark(key)` after the phase body runs (matches the
 *      existing inline `phaseTime(key)` closure)
 *   3. `finishMeasurement(ctx)` — compute totalMs/busiestMs, fire `tick_hitch`
 *      if over threshold, push to history ring. Returns metrics so the
 *      caller can drive simClock + LoadShedder.
 *   4. `recordSample(ctx)` — accumulate one sample; emit `tick_budget` once
 *      every 60 samples (≈ 1 s wall-clock).
 */

export interface ServerLogEventFn {
  (event: string, payload: Record<string, unknown>): void;
}

export interface FinishMeasurementContext {
  serverTick: number;
  workerTickMs: number;
  playerCount: number;
  swarmCount: number;
  aiSize: number;
  liveProjectileCount: number;
}

export interface RecordSampleContext {
  serverTick: number;
  playerCount: number;
  swarmCount: number;
  aiSize: number;
}

export interface TickMeasurement {
  totalMs: number;
  busiestMs: number;
}

const DEFAULT_PHASE_KEYS = [
  'sabRead',
  'projectiles',
  'swarmEncode',
  'swarmBroadcast',
  'snapshotBroadcast',
  'aiTick',
  'aiFire',
  'playerMounts',
  'droneMounts',
  'total',
] as const;

export class TickBudgetTelemetry {
  /** Hot-capture threshold for `tick_hitch` events. 12 ms is below the
   *  16.67 ms physics budget but well above the observed steady-state of
   *  ~1 ms — captures genuine hitches before they cascade into client-
   *  visible stutter (24+ ms ticks cause ~13 u correction snaps). */
  static readonly TICK_HITCH_THRESHOLD_MS = 12;
  /** Rate-limit hitch events to avoid flooding the server-event buffer
   *  during a sustained pathology. One per ~250 ms is plenty to
   *  reconstruct the cause; cluster events still get reported via the
   *  `recentTicks` context on the next admitted hitch. */
  static readonly TICK_HITCH_MIN_INTERVAL_MS = 250;
  /** Tick-budget overrun threshold. Any tick whose total wall-clock
   *  exceeds the physics frame budget counts as overrun. */
  static readonly OVER_BUDGET_MS = 16.67;
  /** Rolling history length passed alongside `tick_hitch` events. */
  static readonly HISTORY_RING_SIZE = 3;
  /** Aggregated `tick_budget` emit cadence — samples between emits. */
  static readonly SAMPLE_EMIT_CADENCE = 60;

  private readonly sums: Record<string, number> = {};
  private readonly thisTickPhases: Record<string, number> = {};
  private readonly historyRing: Array<{
    tick: number;
    totalMs: number;
    phases: Record<string, number>;
  }> = [];
  private sampleCount = 0;
  private maxTotalMs = 0;
  private overBudgetCount = 0;
  private lastHitchAtMs = 0;

  private tStart = 0;
  private tPhase = 0;

  constructor(private readonly logEvent: ServerLogEventFn) {
    for (const k of DEFAULT_PHASE_KEYS) {
      this.sums[k] = 0;
      this.thisTickPhases[k] = 0;
    }
  }

  startTick(): void {
    this.tStart = performance.now();
    this.tPhase = this.tStart;
    for (const k of Object.keys(this.thisTickPhases)) this.thisTickPhases[k] = 0;
  }

  /** Record elapsed time since the previous `mark()` / `startTick()` against
   *  `key`. Matches the existing inline `phaseTime(key)` closure semantics. */
  mark(key: string): void {
    const now = performance.now();
    const elapsed = now - this.tPhase;
    this.sums[key] = (this.sums[key] ?? 0) + elapsed;
    this.thisTickPhases[key] = (this.thisTickPhases[key] ?? 0) + elapsed;
    this.tPhase = now;
  }

  finishMeasurement(ctx: FinishMeasurementContext): TickMeasurement {
    const totalMs = performance.now() - this.tStart;
    this.sums['total'] = (this.sums['total'] ?? 0) + totalMs;
    this.sampleCount++;
    if (totalMs > this.maxTotalMs) this.maxTotalMs = totalMs;
    if (totalMs > TickBudgetTelemetry.OVER_BUDGET_MS) this.overBudgetCount++;

    const nowMs = performance.now();
    if (
      totalMs > TickBudgetTelemetry.TICK_HITCH_THRESHOLD_MS &&
      nowMs - this.lastHitchAtMs >= TickBudgetTelemetry.TICK_HITCH_MIN_INTERVAL_MS
    ) {
      this.lastHitchAtMs = nowMs;
      const phasesSnapshot: Record<string, number> = {};
      for (const k of Object.keys(this.thisTickPhases)) {
        phasesSnapshot[k] = parseFloat((this.thisTickPhases[k] ?? 0).toFixed(3));
      }
      phasesSnapshot['total'] = parseFloat(totalMs.toFixed(3));
      this.logEvent('tick_hitch', {
        serverTick: ctx.serverTick,
        totalMs: parseFloat(totalMs.toFixed(3)),
        phases: phasesSnapshot,
        recentTicks: this.historyRing.slice(),
        workerTickMs: parseFloat(ctx.workerTickMs.toFixed(3)),
        playerCount: ctx.playerCount,
        swarmCount: ctx.swarmCount,
        aiSize: ctx.aiSize,
        liveProjectileCount: ctx.liveProjectileCount,
      });
    }

    this.historyRing.push({
      tick: ctx.serverTick,
      totalMs: parseFloat(totalMs.toFixed(3)),
      phases: { ...this.thisTickPhases },
    });
    if (this.historyRing.length > TickBudgetTelemetry.HISTORY_RING_SIZE) {
      this.historyRing.shift();
    }

    const busiestMs = Math.max(totalMs, ctx.workerTickMs);
    return { totalMs, busiestMs };
  }

  recordSample(ctx: RecordSampleContext): void {
    if (this.sampleCount < TickBudgetTelemetry.SAMPLE_EMIT_CADENCE) return;
    const avg: Record<string, number> = {};
    for (const k of Object.keys(this.sums)) {
      avg[k] = parseFloat((this.sums[k]! / this.sampleCount).toFixed(3));
    }
    this.logEvent('tick_budget', {
      serverTick: ctx.serverTick,
      sampleCount: this.sampleCount,
      avgMs: avg,
      maxTotalMs: parseFloat(this.maxTotalMs.toFixed(3)),
      overBudgetCount: this.overBudgetCount,
      playerCount: ctx.playerCount,
      swarmCount: ctx.swarmCount,
      aiSize: ctx.aiSize,
    });
    for (const k of Object.keys(this.sums)) this.sums[k] = 0;
    this.sampleCount = 0;
    this.maxTotalMs = 0;
    this.overBudgetCount = 0;
  }
}
