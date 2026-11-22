/**
 * Net-health HUD building blocks (pure): a fixed-capacity rolling window and
 * show / hide hysteresis gates. Used by `netHealth.ts`; allocation happens
 * only at construction.
 */

/** Rolling window every 1 s metric is averaged / counted over (ms). */
export const NET_HEALTH_WINDOW_MS = 1000;
/** How often the cluster samples the counters (ms, wall time). */
export const NET_HEALTH_SAMPLE_MS = 100;
/** An indicator hides only once its metric is under this × its threshold ... */
export const NET_HEALTH_HIDE_RATIO = 0.8;
/** ... continuously for this long (ms). */
export const NET_HEALTH_HIDE_HOLD_MS = 2000;

/** Ring capacity for a window: one window of samples plus slack for timer jitter. */
export function ringCapacityFor(windowMs: number): number {
  return Math.ceil(windowMs / NET_HEALTH_SAMPLE_MS) * 2 + 4;
}
const MS_PER_S = 1000;

/** A fixed-capacity time-stamped ring: mean / max / per-second rate over the
 *  last `windowMs`. Allocates its two typed arrays once. */
export class RollingWindow {
  private readonly t: Float64Array;
  private readonly v: Float64Array;
  private head = 0;
  private n = 0;

  constructor(private readonly windowMs: number = NET_HEALTH_WINDOW_MS, capacity: number = ringCapacityFor(NET_HEALTH_WINDOW_MS)) {
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
  }

  get size(): number { return this.n; }

  push(nowMs: number, value: number): void {
    this.evict(nowMs);
    const cap = this.t.length;
    this.t[this.head] = nowMs;
    this.v[this.head] = value;
    this.head = (this.head + 1) % cap;
    if (this.n < cap) this.n++;
  }

  /** Drop samples older than the window. */
  evict(nowMs: number): void {
    const cap = this.t.length;
    while (this.n > 0) {
      const oldest = (this.head - this.n + cap) % cap;
      if ((this.t[oldest] ?? 0) > nowMs - this.windowMs) break;
      this.n--;
    }
  }

  /** Mean of the samples in the window; 0 when empty. */
  mean(): number { return this.n === 0 ? 0 : this.sum() / this.n; }

  /** Largest sample in the window; 0 when empty. */
  max(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const x = this.v[this.idx(i)] ?? 0;
      if (i === 0 || x > m) m = x;
    }
    return m;
  }

  sum(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.v[this.idx(i)] ?? 0;
    return s;
  }

  /** Sum of the window's samples expressed per second. */
  ratePerSecond(): number { return this.sum() * (MS_PER_S / this.windowMs); }

  clear(): void { this.head = 0; this.n = 0; }

  private idx(i: number): number {
    const cap = this.t.length;
    return (this.head - this.n + i + cap) % cap;
  }
}

/** Show-at-threshold, hide-after-hold hysteresis for one indicator. */
export class HysteresisGate {
  shown = false;
  private belowSinceMs = -1;

  constructor(
    private readonly hideRatio: number = NET_HEALTH_HIDE_RATIO,
    private readonly holdMs: number = NET_HEALTH_HIDE_HOLD_MS,
  ) {}

  update(value: number, threshold: number, nowMs: number): boolean {
    if (!this.shown) {
      if (value >= threshold) { this.shown = true; this.belowSinceMs = -1; }
      return this.shown;
    }
    if (value >= threshold * this.hideRatio) { this.belowSinceMs = -1; return true; }
    if (this.belowSinceMs < 0) this.belowSinceMs = nowMs;
    if (nowMs - this.belowSinceMs >= this.holdMs) { this.shown = false; this.belowSinceMs = -1; }
    return this.shown;
  }

  reset(): void { this.shown = false; this.belowSinceMs = -1; }
}

export type NetLevel = 'warn' | 'bad';

/**
 * Two-tier gate: shows amber when `warnScore` reaches 1 and red when
 * `badScore` does (scores are metric / threshold), each with its own
 * hysteresis, so neither visibility nor colour flickers.
 */
export class TieredGate {
  shown = false;
  level: NetLevel = 'warn';
  private readonly warn = new HysteresisGate();
  private readonly bad = new HysteresisGate();

  update(warnScore: number, badScore: number, nowMs: number): void {
    const w = this.warn.update(warnScore, 1, nowMs);
    const b = this.bad.update(badScore, 1, nowMs);
    this.shown = w || b;
    this.level = b ? 'bad' : 'warn';
  }

  reset(): void { this.warn.reset(); this.bad.reset(); this.shown = false; this.level = 'warn'; }
}
