/**
 * Process tick health: ONE pino line per process per 10 s bucket for the
 * whole server, built from every room's `TickHealthWindow`.
 *
 * Why one line: the things that make rooms fall behind together (event-loop
 * delay, OS CPU contention, GC) are process-wide. A per-room line repeated
 * the same story once per sector (a playtest logged 415 info + 238 warn lines
 * in minutes, mostly idle rooms). The per-room windows close on the same
 * wall-clock buckets (`floor(now / TICK_HEALTH_WINDOW_MS)`), so this
 * aggregate sees every room's window for one bucket together.
 *
 * It is also the ONLY reader of the event-loop delay histogram: it reads and
 * resets it once per bucket. (The first version let every room read a shared
 * histogram and the first one reset it; rooms close their windows in the same
 * timer phase, so every room after the first read an empty histogram and
 * logged 0.)
 *
 * `cause` separates the three ways a room falls behind:
 *  - `sim-cost`: tick work itself filled the main thread (`simBusyPct`).
 *  - `main-thread-work`: the loop was busy (`loopBusyPct`, event-loop
 *    utilisation) but not with sim ticks: GC, network, persistence.
 *  - `timer-starvation`: neither was busy, yet timers fired late (gaps,
 *    event-loop delay): the process was not scheduled (CPU contention).
 */

import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

/** Window and bucket length (wall ms); per-room windows align to it. */
export const TICK_HEALTH_WINDOW_MS = 10_000;
/** A room is behind when it achieved less than this share of its target rate. */
export const TICK_HEALTH_DEGRADED_RATIO = 0.9;
/** One gap between a room's tick starts longer than this is a stall. */
export const TICK_GAP_WARN_MS = 250;
/** At most one coalesced stall warn per process per this many wall ms. */
export const TICK_GAP_WARN_MIN_INTERVAL_MS = 5_000;
/** A bucket is flushed this long after it ends, so late rooms still land in it. */
export const TICK_HEALTH_FLUSH_GRACE_MS = 2_000;
/** Sim ticks used at least this share of wall time ⇒ `sim-cost`. */
export const SIM_COST_BUSY_SHARE = 0.5;
/** Event loop busy at least this share (and sim was not) ⇒ `main-thread-work`. */
export const MAIN_THREAD_BUSY_SHARE = 0.7;
/** Event-loop delay histogram resolution (ms). */
export const EVENT_LOOP_RESOLUTION_MS = 10;

const NS_PER_MS = 1e6;
const MS_PER_S = 1000;
const PCT = 100;

export type TickHealthCause = 'sim-cost' | 'main-thread-work' | 'timer-starvation';

/** Fields of the per-process "behind" info line. */
export interface ProcessTickHealthSummary {
  windowS: number;
  rooms: number;
  roomsBehind: number;
  worstRoom: string;
  minTicksPerS: number;
  targetTicksPerS: number;
  maxGapMs: number;
  maxGapRoom: string;
  maxTickMs: number;
  overBudgetTicks: number;
  simBusyPct: number;
  loopBusyPct: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  cause: TickHealthCause;
}

/** Fields of the coalesced stall warn line. */
export interface ProcessTickStallWarn {
  windowS: number;
  stalls: number;
  worstGapMs: number;
  worstRoom: string;
  targetTicksPerS: number;
}

/** The pino surface written to (`pino.Logger` satisfies it). */
export interface TickHealthLogSink {
  info(fields: ProcessTickHealthSummary, msg: string): void;
  warn(fields: ProcessTickStallWarn, msg: string): void;
}

/** The `perf_hooks` histogram surface used (`IntervalHistogram` satisfies it). */
export interface DelayHistogram {
  readonly count: number;
  readonly max: number;
  percentile(p: number): number;
  enable(): boolean;
  reset(): void;
}

/** Main-thread loop health over the interval since the previous read. */
export interface LoopHealthReading {
  p99Ms: number;
  maxMs: number;
  /** Event-loop utilisation, 0–1; NaN when unavailable. */
  busyShare: number;
}

/** Read-and-reset source of loop health (one reader: the process aggregate). */
export interface LoopHealthSource {
  read(out: LoopHealthReading): void;
}

/**
 * `monitorEventLoopDelay` + `performance.eventLoopUtilization`, enabled at
 * construction so the first reading already has samples.
 *
 * Units: the histogram records NANOSECONDS, and each sample is the whole time
 * between two of its `resolution`-ms timer callbacks, not the delay past it
 * (an idle loop reads ≈ resolution, or the OS timer tick: ~15.6 ms on
 * Windows). The delay is `sample − resolution`, floored at 0.
 */
export class EventLoopHealth implements LoopHealthSource {
  private prevElu: EventLoopUtilization | null;

  constructor(
    private readonly histogram: DelayHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS }),
    private readonly resolutionMs: number = EVENT_LOOP_RESOLUTION_MS,
    private readonly elu: ((prev?: EventLoopUtilization) => EventLoopUtilization) | null = (prev) =>
      performance.eventLoopUtilization(prev),
  ) {
    this.histogram.enable();
    this.prevElu = this.elu ? this.elu() : null;
  }

  read(out: LoopHealthReading): void {
    const h = this.histogram;
    // An empty histogram reports NaN / sentinel values: treat as zero.
    out.p99Ms = h.count > 0 ? this.delayMs(h.percentile(99)) : 0;
    out.maxMs = h.count > 0 ? this.delayMs(h.max) : 0;
    h.reset();
    if (this.elu && this.prevElu) {
      const now = this.elu();
      out.busyShare = this.elu(this.prevElu).utilization;
      this.prevElu = now;
    } else {
      out.busyShare = Number.NaN;
    }
  }

  private delayMs(sampleNs: number): number {
    return Math.max(0, sampleNs / NS_PER_MS - this.resolutionMs);
  }
}

/** What a room's closed window exposes (read in place: no per-window object). */
export interface ClosedRoomWindow {
  readonly bucket: number;
  readonly room: string;
  readonly elapsedMs: number;
  readonly ticks: number;
  readonly ticksPerS: number;
  readonly targetTicksPerS: number;
  readonly maxTickMs: number;
  readonly maxGapMs: number;
  readonly overBudgetTicks: number;
  readonly workMs: number;
  readonly behind: boolean;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export class ProcessTickHealth {
  private openBucket = Number.NEGATIVE_INFINITY;
  private hasData = false;
  private lastReadMs = Number.NaN;
  private intervalMs = TICK_HEALTH_WINDOW_MS;
  private readonly loop: LoopHealthReading = { p99Ms: 0, maxMs: 0, busyShare: Number.NaN };

  private rooms = 0;
  private roomsBehind = 0;
  private worstRoom = '';
  private minRatio = Number.POSITIVE_INFINITY;
  private minTicksPerS = 0;
  private worstTarget = 0;
  private maxGapMs = 0;
  private maxGapRoom = '';
  private maxTickMs = 0;
  private overBudgetTicks = 0;
  private workMs = 0;

  private stalls = 0;
  private worstStallMs = 0;
  private worstStallRoom = '';
  private stallTarget = 0;
  private lastWarnMs = Number.NEGATIVE_INFINITY;
  private stallsSinceMs = Number.NaN;

  /** Buckets flushed, and how many logged (test + diag hook). */
  bucketsFlushed = 0;
  bucketsLogged = 0;

  constructor(
    private readonly log: TickHealthLogSink,
    private readonly loopSource: LoopHealthSource = new EventLoopHealth(),
  ) {}

  /** Called every tick by every room: flushes a finished bucket and pending stalls. */
  poll(nowMs: number): void {
    if (this.hasData && nowMs >= (this.openBucket + 1) * TICK_HEALTH_WINDOW_MS + TICK_HEALTH_FLUSH_GRACE_MS) {
      this.flush();
    }
    if (this.stalls > 0 && nowMs - this.lastWarnMs >= TICK_GAP_WARN_MIN_INTERVAL_MS) this.warnStalls(nowMs);
  }

  /** One room's window for `w.bucket` closed at `nowMs`. */
  report(nowMs: number, w: ClosedRoomWindow): void {
    if (!this.hasData || w.bucket > this.openBucket) {
      if (this.hasData) this.flush();
      // A late room (bucket already flushed) opens the next aggregate.
      this.openBucket = Math.max(w.bucket, this.openBucket);
      this.hasData = true;
      // The first window to close for a bucket reads the loop for it: the
      // read covers the time since the previous bucket's first close.
      this.loopSource.read(this.loop);
      if (!Number.isNaN(this.lastReadMs)) this.intervalMs = Math.max(1, nowMs - this.lastReadMs);
      this.lastReadMs = nowMs;
    }
    this.rooms++;
    this.workMs += w.workMs;
    this.overBudgetTicks += w.overBudgetTicks;
    if (w.maxTickMs > this.maxTickMs) this.maxTickMs = w.maxTickMs;
    if (w.maxGapMs > this.maxGapMs) {
      this.maxGapMs = w.maxGapMs;
      this.maxGapRoom = w.room;
    }
    if (w.behind) this.roomsBehind++;
    const ratio = w.ticksPerS / w.targetTicksPerS;
    if (ratio < this.minRatio) {
      this.minRatio = ratio;
      this.minTicksPerS = w.ticksPerS;
      this.worstTarget = w.targetTicksPerS;
      this.worstRoom = w.room;
    }
  }

  /** One room saw a gap over `TICK_GAP_WARN_MS`; coalesced into one warn per interval. */
  stall(nowMs: number, room: string, gapMs: number, targetTicksPerS: number): void {
    if (this.stalls === 0) this.stallsSinceMs = nowMs;
    this.stalls++;
    if (gapMs > this.worstStallMs) {
      this.worstStallMs = gapMs;
      this.worstStallRoom = room;
      this.stallTarget = targetTicksPerS;
    }
    if (nowMs - this.lastWarnMs >= TICK_GAP_WARN_MIN_INTERVAL_MS) this.warnStalls(nowMs);
  }

  /** The cause label for a behind bucket (exported via the summary line). */
  static classify(simBusyShare: number, loopBusyShare: number): TickHealthCause {
    if (simBusyShare >= SIM_COST_BUSY_SHARE) return 'sim-cost';
    if (loopBusyShare >= MAIN_THREAD_BUSY_SHARE) return 'main-thread-work';
    return 'timer-starvation';
  }

  private warnStalls(nowMs: number): void {
    this.log.warn(
      {
        windowS: round1(Math.max(0, nowMs - this.stallsSinceMs) / MS_PER_S),
        stalls: this.stalls,
        worstGapMs: round1(this.worstStallMs),
        worstRoom: this.worstStallRoom,
        targetTicksPerS: round1(this.stallTarget),
      },
      'server tick stalled',
    );
    this.lastWarnMs = nowMs;
    this.stalls = 0;
    this.worstStallMs = 0;
    this.worstStallRoom = '';
  }

  private flush(): void {
    this.bucketsFlushed++;
    if (this.roomsBehind > 0) {
      this.bucketsLogged++;
      const simBusy = this.workMs / this.intervalMs;
      const loopBusy = this.loop.busyShare;
      this.log.info(
        {
          windowS: round1(this.intervalMs / MS_PER_S),
          rooms: this.rooms,
          roomsBehind: this.roomsBehind,
          worstRoom: this.worstRoom,
          minTicksPerS: round1(this.minTicksPerS),
          targetTicksPerS: round1(this.worstTarget),
          maxGapMs: round1(this.maxGapMs),
          maxGapRoom: this.maxGapRoom,
          maxTickMs: round1(this.maxTickMs),
          overBudgetTicks: this.overBudgetTicks,
          simBusyPct: round1(simBusy * PCT),
          loopBusyPct: Number.isNaN(loopBusy) ? -1 : round1(loopBusy * PCT),
          eventLoopP99Ms: round1(this.loop.p99Ms),
          eventLoopMaxMs: round1(this.loop.maxMs),
          cause: ProcessTickHealth.classify(simBusy, Number.isNaN(loopBusy) ? 0 : loopBusy),
        },
        'server sim behind target tick rate',
      );
    }
    this.hasData = false;
    this.rooms = 0;
    this.roomsBehind = 0;
    this.worstRoom = '';
    this.minRatio = Number.POSITIVE_INFINITY;
    this.minTicksPerS = 0;
    this.worstTarget = 0;
    this.maxGapMs = 0;
    this.maxGapRoom = '';
    this.maxTickMs = 0;
    this.overBudgetTicks = 0;
    this.workMs = 0;
  }
}

let shared: ProcessTickHealth | null = null;

/** The one per-process aggregate; the first caller's logger is used. */
export function processTickHealth(log: TickHealthLogSink): ProcessTickHealth {
  if (shared === null) shared = new ProcessTickHealth(log);
  return shared;
}
