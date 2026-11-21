/**
 * Tick health window: one room's share of the process tick-health log.
 *
 * Why: a phone-lane playtest saw the server drop from 60 to 24–43 ticks/s for
 * ~40 s (send pauses up to 1.3 s) while the server logged nothing, so CPU
 * contention on the dev PC could not be proven. `TickBudgetTelemetry` already
 * measures every tick for the diag event buffer; this window rides on the same
 * `endTick` call.
 *
 * Per window it keeps scalars only (no per-tick allocation, invariant #14):
 * tick count, max tick duration, summed tick work, max gap between tick
 * starts, ticks over their period. Windows align to process wall-clock
 * buckets (`floor(now / TICK_HEALTH_WINDOW_MS)`), so every room closes the
 * same bucket together and hands it to `ProcessTickHealth`, which writes ONE
 * line per process (event-loop delay and starvation are process-wide). Gaps
 * over `TICK_GAP_WARN_MS` are reported there too, coalesced into one warn.
 */

import { tickPeriodMs } from '../../core/physics/catchUp.js';
import {
  TICK_HEALTH_WINDOW_MS,
  TICK_HEALTH_DEGRADED_RATIO,
  TICK_GAP_WARN_MS,
  type ClosedRoomWindow,
  type ProcessTickHealth,
} from './ProcessTickHealth.js';

/** A window shorter than this (a room's first, partial one) is judged on gaps only. */
export const TICK_HEALTH_MIN_RATE_WINDOW_MS = 2_000;
const MS_PER_S = 1000;

/** The process aggregate surface a room window feeds (`ProcessTickHealth` satisfies it). */
export type TickHealthSink = Pick<ProcessTickHealth, 'poll' | 'report' | 'stall'>;

export class TickHealthWindow implements ClosedRoomWindow {
  private windowStartMs = Number.NaN;
  private lastTickStartMs = Number.NaN;

  // ClosedRoomWindow fields: valid while `sink.report` runs.
  bucket = Number.NaN;
  room = '';
  elapsedMs = 0;
  ticks = 0;
  ticksPerS = 0;
  targetTicksPerS = 0;
  maxTickMs = 0;
  maxGapMs = 0;
  overBudgetTicks = 0;
  workMs = 0;
  behind = false;

  /** Windows closed so far, and how many were behind (test + diag hook). */
  windowsClosed = 0;
  windowsBehind = 0;

  constructor(
    private readonly sink: TickHealthSink,
    private readonly roomLabel: () => string,
  ) {}

  /**
   * Record one finished tick. `tickStartMs` is the tick's `performance.now()`
   * start, `tickMs` its duration, `timeScale` the sector's game speed (target
   * rate is 60 × speed per wall second).
   */
  record(tickStartMs: number, tickMs: number, timeScale: number): void {
    const periodMs = tickPeriodMs(timeScale);
    this.targetTicksPerS = MS_PER_S / periodMs;
    const bucket = Math.floor(tickStartMs / TICK_HEALTH_WINDOW_MS);
    if (Number.isNaN(this.windowStartMs)) {
      this.windowStartMs = tickStartMs;
      this.bucket = bucket;
    } else {
      const gapMs = tickStartMs - this.lastTickStartMs;
      if (gapMs > this.maxGapMs) this.maxGapMs = gapMs;
      if (gapMs > TICK_GAP_WARN_MS) this.sink.stall(tickStartMs, this.roomLabel(), gapMs, this.targetTicksPerS);
      // The window holds the ticks that STARTED in its bucket: close it
      // first, then this tick opens the next one.
      if (bucket > this.bucket) this.close(tickStartMs, bucket);
    }
    this.lastTickStartMs = tickStartMs;
    this.ticks++;
    this.workMs += tickMs;
    if (tickMs > this.maxTickMs) this.maxTickMs = tickMs;
    if (tickMs > periodMs) this.overBudgetTicks++;
    this.sink.poll(tickStartMs);
  }

  private close(nowMs: number, nextBucket: number): void {
    this.elapsedMs = nowMs - this.windowStartMs;
    this.ticksPerS = this.elapsedMs > 0 ? (this.ticks * MS_PER_S) / this.elapsedMs : 0;
    const slow =
      this.elapsedMs >= TICK_HEALTH_MIN_RATE_WINDOW_MS &&
      this.ticksPerS < this.targetTicksPerS * TICK_HEALTH_DEGRADED_RATIO;
    this.behind = slow || this.maxGapMs > TICK_GAP_WARN_MS;
    this.room = this.roomLabel();
    this.windowsClosed++;
    if (this.behind) this.windowsBehind++;
    this.sink.report(nowMs, this);

    this.bucket = nextBucket;
    this.windowStartMs = nowMs;
    this.ticks = 0;
    this.workMs = 0;
    this.maxTickMs = 0;
    this.maxGapMs = 0;
    this.overBudgetTicks = 0;
  }
}
