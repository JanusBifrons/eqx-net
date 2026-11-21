import { describe, it, expect, vi } from 'vitest';
import { TickHealthWindow } from './TickHealthWindow.js';
import {
  ProcessTickHealth,
  EventLoopHealth,
  TICK_HEALTH_WINDOW_MS,
  TICK_HEALTH_FLUSH_GRACE_MS,
  TICK_GAP_WARN_MS,
  TICK_GAP_WARN_MIN_INTERVAL_MS,
  type DelayHistogram,
  type LoopHealthReading,
  type LoopHealthSource,
  type TickHealthLogSink,
} from './ProcessTickHealth.js';
import { TickBudgetTelemetry } from './TickBudgetTelemetry.js';

vi.mock('../debug/ServerEventLog.js', () => ({
  serverLogEvent: vi.fn(),
  getRecentEvents: vi.fn(() => []),
  clearEvents: vi.fn(),
}));

// Scripted clock throughout (root CLAUDE.md "Gate on counts, compare
// timings"): every tick start and duration is injected.

const PERIOD_MS = 1000 / 60;
const NS = 1e6;

type Sink = TickHealthLogSink & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
function sink(): Sink {
  return { info: vi.fn(), warn: vi.fn() };
}

function fixedLoop(p99Ms: number, maxMs: number, busyShare: number): LoopHealthSource & { reads: number } {
  return {
    reads: 0,
    read(out: LoopHealthReading) {
      this.reads++;
      out.p99Ms = p99Ms;
      out.maxMs = maxMs;
      out.busyShare = busyShare;
    },
  };
}

/** A histogram that holds scripted samples (ns) until `reset()`, like perf_hooks. */
class FakeHistogram implements DelayHistogram {
  samples: number[] = [];
  enabled = false;
  get count(): number {
    return this.samples.length;
  }
  get max(): number {
    return this.samples.length ? Math.max(...this.samples) : 0;
  }
  percentile(p: number): number {
    const s = [...this.samples].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : Number.NaN;
  }
  enable(): boolean {
    this.enabled = true;
    return true;
  }
  reset(): void {
    this.samples = [];
  }
}

/** Drive rooms in lockstep for `seconds` at `hz`, each tick `tickMs` long. Returns the next start. */
function drive(rooms: TickHealthWindow[], startMs: number, seconds: number, hz: number, tickMs = 2, scale = 1): number {
  const step = 1000 / hz;
  const n = Math.round(seconds * hz);
  let t = startMs;
  for (let i = 0; i < n; i++) {
    for (const r of rooms) r.record(t, tickMs, scale);
    t += step;
  }
  return t;
}

function rooms(agg: ProcessTickHealth, n: number): TickHealthWindow[] {
  const out: TickHealthWindow[] = [];
  for (let i = 0; i < n; i++) {
    const label = `sec-${i}`;
    out.push(new TickHealthWindow(agg, () => label));
  }
  return out;
}

/** Enough time for bucket 0 (rooms start at 1 s) to close and flush. */
const ONE_BUCKET_S = (TICK_HEALTH_WINDOW_MS + TICK_HEALTH_FLUSH_GRACE_MS) / 1000;

describe('TickHealthWindow + ProcessTickHealth', () => {
  it('stays silent while every room holds 60 ticks/s', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(1, 3, 0.1));
    const rs = rooms(agg, 3);
    drive(rs, 1_000, 31, 60);
    expect(rs[0]!.windowsClosed).toBe(3);
    expect(agg.bucketsFlushed).toBe(2);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs ONE line per process per bucket however many rooms fell behind', () => {
    const log = sink();
    const loop = fixedLoop(12, 480, 0.2);
    const agg = new ProcessTickHealth(log, loop);
    const rs = rooms(agg, 12);
    // 30 ticks/s for one bucket, every tick 1 ms.
    drive(rs, 1_000, ONE_BUCKET_S + 0.1, 30, 1);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(loop.reads).toBe(1);
    const [fields, msg] = log.info.mock.calls[0] as [Record<string, number | string>, string];
    expect(msg).toBe('server sim behind target tick rate');
    expect(fields['rooms']).toBe(12);
    expect(fields['roomsBehind']).toBe(12);
    expect(fields['minTicksPerS']).toBeCloseTo(30, 0);
    expect(fields['targetTicksPerS']).toBe(60);
    expect(fields['eventLoopP99Ms']).toBe(12);
    expect(fields['eventLoopMaxMs']).toBe(480);
    expect(fields['loopBusyPct']).toBe(20);
  });

  it('names the worst room, its rate and the largest gap', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(0, 0, 0));
    const fast = new TickHealthWindow(agg, () => 'fast');
    const slow = new TickHealthWindow(agg, () => 'slow');
    let t = 1_000;
    for (let i = 0; i < 60 * ONE_BUCKET_S + 6; i++) {
      fast.record(t, 1, 1);
      if (i % 3 === 0) slow.record(t, 1, 1);
      t += PERIOD_MS;
    }
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number | string>;
    expect(fields['rooms']).toBe(2);
    expect(fields['roomsBehind']).toBe(1);
    expect(fields['worstRoom']).toBe('slow');
    expect(fields['minTicksPerS']).toBeCloseTo(20, 0);
    expect(fields['maxGapRoom']).toBe('slow');
  });

  // Regression: the first version let every room read (and the first one
  // reset) one shared histogram. Rooms close their windows in the same timer
  // phase, so every room after the first read an EMPTY histogram and the
  // playtest logged eventLoopP99Ms 0 / eventLoopMaxMs 0 on every line.
  it('reads the event-loop histogram once per bucket, so lockstep rooms still report the real delay', () => {
    const log = sink();
    const h = new FakeHistogram();
    const agg = new ProcessTickHealth(log, new EventLoopHealth(h, 10, null));
    const rs = rooms(agg, 8);
    expect(h.enabled).toBe(true); // enabled up front, not on first read
    let t = 1_000;
    const n = Math.round(ONE_BUCKET_S * 30) + 3;
    for (let i = 0; i < n; i++) {
      // The loop records a 60 ms timer interval (50 ms of delay) every tick.
      h.samples.push(60 * NS);
      for (const r of rs) r.record(t, 1, 1);
      t += 1000 / 30;
    }
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number>;
    expect(fields['rooms']).toBe(8);
    expect(fields['eventLoopP99Ms']).toBe(50);
    expect(fields['eventLoopMaxMs']).toBe(50);
  });

  it('coalesces stalls across rooms into one rate-limited warn with a count and the worst gap', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(0, 0, 0));
    const rs = rooms(agg, 5);
    let t = drive(rs, 1_000, 1, 60);
    t += 400;
    t = drive(rs, t, 1, 60);
    expect(log.warn).toHaveBeenCalledTimes(1);
    let [fields, msg] = log.warn.mock.calls[0] as [Record<string, number | string>, string];
    expect(msg).toBe('server tick stalled');
    expect(fields['stalls']).toBe(1); // the first room's stall warns at once
    // The other four rooms' stalls, plus a second process stall 1 s later,
    // wait out the interval and come out as ONE warn.
    t += 600;
    drive(rs, t, TICK_GAP_WARN_MIN_INTERVAL_MS / 1000, 60);
    expect(log.warn).toHaveBeenCalledTimes(2);
    [fields] = log.warn.mock.calls[1] as [Record<string, number | string>, string];
    expect(fields['stalls']).toBe(9);
    expect(fields['worstGapMs']).toBeCloseTo(600 + PERIOD_MS, 0);
    expect(fields['worstGapMs']).toBeGreaterThan(TICK_GAP_WARN_MS);
    expect(fields['worstRoom']).toBe('sec-0');
  });

  it('labels timer starvation: big gaps, tiny tick work, idle loop', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(40, 340, 0.15));
    const rs = rooms(agg, 4);
    let t = 1_000;
    for (let s = 0; s < ONE_BUCKET_S; s++) {
      t = drive(rs, t, 0.7, 60, 0.5);
      t += 300;
    }
    drive(rs, t, 0.1, 60, 0.5);
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number | string>;
    expect(fields['cause']).toBe('timer-starvation');
    expect(fields['simBusyPct'] as number).toBeLessThan(10);
  });

  it('labels sim cost when tick work fills the main thread', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(20, 40, 0.95));
    const rs = rooms(agg, 2);
    // 2 rooms × 30 ticks/s × 15 ms = 90 % of wall time in ticks.
    drive(rs, 1_000, ONE_BUCKET_S + 0.1, 30, 15);
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number | string>;
    expect(fields['cause']).toBe('sim-cost');
  });

  it('classifies by sim share first, then loop utilisation', () => {
    expect(ProcessTickHealth.classify(0.6, 0.9)).toBe('sim-cost');
    expect(ProcessTickHealth.classify(0.1, 0.9)).toBe('main-thread-work');
    expect(ProcessTickHealth.classify(0.1, 0.2)).toBe('timer-starvation');
  });

  it('targets 60 × game speed', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(0, 0, 0));
    const rs = rooms(agg, 1);
    // 60 ticks/s at 2× speed is half the target.
    drive(rs, 1_000, ONE_BUCKET_S + 0.1, 60, 2, 2);
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number>;
    expect(fields['targetTicksPerS']).toBe(120);
  });

  it('TickBudgetTelemetry feeds the window from endTick', () => {
    const log = sink();
    const agg = new ProcessTickHealth(log, fixedLoop(0, 0, 0));
    const w = new TickHealthWindow(agg, () => 'sec-e');
    const t = new TickBudgetTelemetry(w);
    let clock = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      for (let i = 0; i < 25 * (ONE_BUCKET_S + 1); i++) {
        t.beginTick(clock);
        clock += 2;
        t.endTick({ serverTick: i, workerTickMs: 1, playerCount: 1, swarmCount: 0, aiSize: 0, liveProjectileCount: 0 });
        clock += 1000 / 25 - 2;
      }
    } finally {
      spy.mockRestore();
    }
    expect(w.windowsClosed).toBe(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

describe('EventLoopHealth', () => {
  it('converts ns samples to ms of delay past the timer resolution', () => {
    const h = new FakeHistogram();
    const src = new EventLoopHealth(h, 10, null);
    h.samples.push(11 * NS, 35 * NS, 510 * NS);
    const out: LoopHealthReading = { p99Ms: -1, maxMs: -1, busyShare: -1 };
    src.read(out);
    expect(out.p99Ms).toBe(500);
    expect(out.maxMs).toBe(500);
    expect(Number.isNaN(out.busyShare)).toBe(true);
    // A read resets: an empty interval reads 0, never NaN.
    src.read(out);
    expect(out.p99Ms).toBe(0);
    expect(out.maxMs).toBe(0);
  });

  it('the real perf_hooks histogram sees a blocked event loop', async () => {
    const src = new EventLoopHealth();
    const out: LoopHealthReading = { p99Ms: 0, maxMs: 0, busyShare: 0 };
    await new Promise((r) => setTimeout(r, 30));
    src.read(out); // drop startup samples
    const until = Date.now() + 80;
    while (Date.now() < until) { /* block */ }
    await new Promise((r) => setTimeout(r, 30));
    src.read(out);
    expect(out.maxMs).toBeGreaterThan(0);
    expect(out.busyShare).toBeGreaterThan(0);
  });
});
