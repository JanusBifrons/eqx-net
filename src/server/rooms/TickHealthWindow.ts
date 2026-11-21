/**
 * Tick health window: a 10 s per-room pino summary of the fixed-step loop,
 * logged ONLY when the sim fell behind.
 *
 * Why: a phone-lane playtest saw the server drop from 60 to 24–43 ticks/s for
 * ~40 s (send pauses up to 1.3 s) while the server logged nothing, so CPU
 * contention on the dev PC could not be proven. `TickBudgetTelemetry` already
 * measures every tick for the diag event buffer; this window rides on the same
 * `endTick` call and writes the operator-facing log line.
 *
 * Per window it keeps scalars only (no per-tick allocation, invariant #14):
 * tick count, max tick duration, max gap between tick starts, ticks over
 * their period. At the close it reads the process event-loop delay
 * (`perf_hooks.monitorEventLoopDelay`, one histogram per process). A single
 * gap over `TICK_GAP_WARN_MS` also logs one rate-limited warn.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { tickPeriodMs } from '../../core/physics/catchUp.js';

/** Window length for the degraded-rate summary (wall ms). */
export const TICK_HEALTH_WINDOW_MS = 10_000;
/** A window is degraded when it achieved less than this share of its target rate. */
export const TICK_HEALTH_DEGRADED_RATIO = 0.9;
/** One gap between tick starts longer than this is a stall (warn line). */
export const TICK_GAP_WARN_MS = 250;
/** At most one stall warn per room per this many wall ms. */
export const TICK_GAP_WARN_MIN_INTERVAL_MS = 5_000;
/** Event-loop delay histogram resolution (ms). */
const EVENT_LOOP_RESOLUTION_MS = 10;
const NS_PER_MS = 1e6;
const MS_PER_S = 1000;

/** The pino surface the window writes to (`pino.Logger` satisfies it). */
export interface TickHealthLogSink {
  info(fields: TickHealthSummary, msg: string): void;
  warn(fields: TickGapWarn, msg: string): void;
}

/** Fields of the degraded-window info line. */
export interface TickHealthSummary {
  room: string;
  windowS: number;
  ticksPerS: number;
  targetTicksPerS: number;
  maxTickMs: number;
  maxGapMs: number;
  overBudgetTicks: number;
  ticks: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
}

/** Fields of the single-stall warn line. */
export interface TickGapWarn {
  room: string;
  gapMs: number;
  targetTicksPerS: number;
}

/** Process event-loop delay, in ms, since the last window that reset it. */
export interface EventLoopLagSource {
  /** Write p99/max (ms) into `out`; reset when the last reset is ≥ one window old. */
  read(nowMs: number, out: { p99Ms: number; maxMs: number }): void;
}

let sharedHistogram: IntervalHistogram | null = null;
let lastResetMs = Number.NEGATIVE_INFINITY;

/**
 * The process-wide event-loop delay source. One histogram per process; rooms
 * share it, and the first room to close a window after it is a window old
 * resets it, so each reading covers at most ~two windows of the whole process.
 */
export const processEventLoopLag: EventLoopLagSource = {
  read(nowMs, out) {
    if (sharedHistogram === null) {
      sharedHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      sharedHistogram.enable();
      lastResetMs = nowMs;
    }
    const h = sharedHistogram;
    // An empty histogram reports NaN / huge sentinels: treat as zero.
    out.p99Ms = h.count > 0 ? h.percentile(99) / NS_PER_MS : 0;
    out.maxMs = h.count > 0 ? h.max / NS_PER_MS : 0;
    if (nowMs - lastResetMs >= TICK_HEALTH_WINDOW_MS) {
      h.reset();
      lastResetMs = nowMs;
    }
  },
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

export class TickHealthWindow {
  private windowStartMs = Number.NaN;
  private lastTickStartMs = Number.NaN;
  private ticks = 0;
  private maxTickMs = 0;
  private maxGapMs = 0;
  private overBudgetTicks = 0;
  private targetTicksPerS = 0;
  private lastGapWarnMs = Number.NEGATIVE_INFINITY;
  private readonly lag = { p99Ms: 0, maxMs: 0 };

  /** Windows closed so far, and how many of them logged (test + diag hook). */
  windowsClosed = 0;
  windowsLogged = 0;

  constructor(
    private readonly log: TickHealthLogSink,
    private readonly roomLabel: () => string,
    private readonly lagSource: EventLoopLagSource = processEventLoopLag,
  ) {}

  /**
   * Record one finished tick. `tickStartMs` is the tick's `performance.now()`
   * start, `tickMs` its duration, `timeScale` the sector's game speed (target
   * rate is 60 × speed per wall second).
   */
  record(tickStartMs: number, tickMs: number, timeScale: number): void {
    const periodMs = tickPeriodMs(timeScale);
    this.targetTicksPerS = MS_PER_S / periodMs;
    if (Number.isNaN(this.windowStartMs)) {
      this.windowStartMs = tickStartMs;
    } else {
      const gapMs = tickStartMs - this.lastTickStartMs;
      if (gapMs > this.maxGapMs) this.maxGapMs = gapMs;
      if (gapMs > TICK_GAP_WARN_MS && tickStartMs - this.lastGapWarnMs >= TICK_GAP_WARN_MIN_INTERVAL_MS) {
        this.lastGapWarnMs = tickStartMs;
        this.log.warn(
          { room: this.roomLabel(), gapMs: round1(gapMs), targetTicksPerS: round1(this.targetTicksPerS) },
          'server tick stalled',
        );
      }
    }
    this.lastTickStartMs = tickStartMs;
    // The window holds the ticks that STARTED in [windowStart, this start):
    // close it first, then this tick opens the next one.
    const elapsedMs = tickStartMs - this.windowStartMs;
    if (elapsedMs >= TICK_HEALTH_WINDOW_MS) this.close(tickStartMs, elapsedMs);
    this.ticks++;
    if (tickMs > this.maxTickMs) this.maxTickMs = tickMs;
    if (tickMs > periodMs) this.overBudgetTicks++;
  }

  private close(nowMs: number, elapsedMs: number): void {
    const ticksPerS = (this.ticks * MS_PER_S) / elapsedMs;
    this.windowsClosed++;
    this.lagSource.read(nowMs, this.lag);
    const degraded =
      ticksPerS < this.targetTicksPerS * TICK_HEALTH_DEGRADED_RATIO || this.maxGapMs > TICK_GAP_WARN_MS;
    if (degraded) {
      this.windowsLogged++;
      this.log.info(
        {
          room: this.roomLabel(),
          windowS: round1(elapsedMs / MS_PER_S),
          ticksPerS: round1(ticksPerS),
          targetTicksPerS: round1(this.targetTicksPerS),
          maxTickMs: round1(this.maxTickMs),
          maxGapMs: round1(this.maxGapMs),
          overBudgetTicks: this.overBudgetTicks,
          ticks: this.ticks,
          eventLoopP99Ms: round1(this.lag.p99Ms),
          eventLoopMaxMs: round1(this.lag.maxMs),
        },
        'server sim behind target tick rate',
      );
    }
    this.windowStartMs = nowMs;
    this.ticks = 0;
    this.maxTickMs = 0;
    this.maxGapMs = 0;
    this.overBudgetTicks = 0;
  }
}
