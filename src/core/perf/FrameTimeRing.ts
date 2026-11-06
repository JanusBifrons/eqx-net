/**
 * A fixed ring of per-frame times (ms) for perf scenes (plan
 * prancy-squishing-donut P2). `push` is allocation-free (it runs every
 * frame); `summary` sorts a copy and is only called when a scene is read.
 *
 * Frame time is judged by percentiles and hitch counts, never mean FPS:
 * one 120 ms stall in a second of 16 ms frames is invisible in a mean.
 */
export interface FrameTimeSummary {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames over 33.4 ms (two refreshes at 60 Hz): a visible hitch. */
  hitches: number;
}

export const HITCH_MS = 33.4;

export class FrameTimeRing {
  private readonly buf: Float32Array;
  private n = 0;
  private head = 0;

  constructor(capacity = 8192) {
    this.buf = new Float32Array(capacity);
  }

  push(ms: number): void {
    this.buf[this.head] = ms;
    this.head = (this.head + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  reset(): void {
    this.n = 0;
    this.head = 0;
  }

  get count(): number { return this.n; }

  summary(): FrameTimeSummary {
    const n = this.n;
    if (n === 0) return { frames: 0, p50: 0, p95: 0, p99: 0, max: 0, hitches: 0 };
    const start = (this.head - n + this.buf.length) % this.buf.length;
    const v = new Float64Array(n);
    let hitches = 0;
    for (let i = 0; i < n; i++) {
      const x = this.buf[(start + i) % this.buf.length]!;
      v[i] = x;
      if (x > HITCH_MS) hitches++;
    }
    v.sort();
    const pick = (q: number): number => round2(v[Math.min(n - 1, Math.floor(q * n))]!);
    return { frames: n, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: round2(v[n - 1]!), hitches };
  }
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
