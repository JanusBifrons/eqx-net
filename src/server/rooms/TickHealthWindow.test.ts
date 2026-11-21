import { describe, it, expect, vi } from 'vitest';
import {
  TickHealthWindow,
  TICK_HEALTH_WINDOW_MS,
  TICK_GAP_WARN_MS,
  TICK_GAP_WARN_MIN_INTERVAL_MS,
  type EventLoopLagSource,
  type TickHealthLogSink,
} from './TickHealthWindow.js';
import { TickBudgetTelemetry } from './TickBudgetTelemetry.js';

vi.mock('../debug/ServerEventLog.js', () => ({
  serverLogEvent: vi.fn(),
  getRecentEvents: vi.fn(() => []),
  clearEvents: vi.fn(),
}));

// Scripted clock throughout (root CLAUDE.md "Gate on counts, compare
// timings"): every tick start and duration is injected.

const PERIOD_MS = 1000 / 60;
const LAG_P99_MS = 12;
const LAG_MAX_MS = 480;

function sink(): TickHealthLogSink & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() };
}

const fixedLag: EventLoopLagSource = {
  read(_now, out) {
    out.p99Ms = LAG_P99_MS;
    out.maxMs = LAG_MAX_MS;
  },
};

/** Drive `seconds` of ticks at `hz`, each `tickMs` long, from `startMs`. Returns the next start. */
function drive(w: TickHealthWindow, startMs: number, seconds: number, hz: number, tickMs = 2): number {
  const step = 1000 / hz;
  const n = Math.round(seconds * hz);
  let t = startMs;
  for (let i = 0; i < n; i++) {
    w.record(t, tickMs, 1);
    t += step;
  }
  return t;
}

describe('TickHealthWindow', () => {
  it('stays silent while the loop holds 60 ticks/s', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-a', fixedLag);
    drive(w, 1_000, 31, 60);
    expect(w.windowsClosed).toBe(3);
    expect(w.windowsLogged).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs one info summary per degraded window with rate, max tick, max gap, over-budget and lag', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-a', fixedLag);
    // 30 ticks/s for 10 s, every tick 20 ms (over the 16.7 ms period).
    drive(w, 1_000, TICK_HEALTH_WINDOW_MS / 1000 + 0.1, 30, 20);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.info.mock.calls[0] as [Record<string, number | string>, string];
    expect(msg).toBe('server sim behind target tick rate');
    expect(fields['room']).toBe('sec-a');
    expect(fields['ticksPerS']).toBeCloseTo(30, 0);
    expect(fields['targetTicksPerS']).toBe(60);
    expect(fields['maxTickMs']).toBe(20);
    expect(fields['maxGapMs']).toBeCloseTo(33.3, 1);
    expect(fields['overBudgetTicks']).toBe(fields['ticks']);
    expect(fields['eventLoopP99Ms']).toBe(LAG_P99_MS);
    expect(fields['eventLoopMaxMs']).toBe(LAG_MAX_MS);
  });

  it('a single long gap degrades the window and logs one rate-limited warn', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-b', fixedLag);
    let t = drive(w, 1_000, 2, 60);
    // Two stalls 1 s apart: only the first warns (rate limit).
    t += 400;
    t = drive(w, t, 1, 60);
    t += 600;
    drive(w, t, 8, 60);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [warnFields, warnMsg] = log.warn.mock.calls[0] as [Record<string, number | string>, string];
    expect(warnMsg).toBe('server tick stalled');
    expect(warnFields['room']).toBe('sec-b');
    expect(warnFields['gapMs']).toBeGreaterThan(TICK_GAP_WARN_MS);
    // Rate held near 60, but the gap alone marks the window degraded.
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number>;
    expect(fields['maxGapMs']).toBeCloseTo(600 + PERIOD_MS, 0);
  });

  it('warns again once the rate-limit interval has passed', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-c', fixedLag);
    let t = drive(w, 1_000, 1, 60);
    t += 300;
    t = drive(w, t, TICK_GAP_WARN_MIN_INTERVAL_MS / 1000 + 0.5, 60);
    t += 300;
    drive(w, t, 1, 60);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('targets 60 × game speed', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-d', fixedLag);
    // 60 ticks/s at 2× speed is half the target.
    let t = 1_000;
    for (let i = 0; i < 61 * 10; i++) {
      w.record(t, 2, 2);
      t += PERIOD_MS;
    }
    expect(log.info).toHaveBeenCalledTimes(1);
    const fields = log.info.mock.calls[0]![0] as Record<string, number>;
    expect(fields['targetTicksPerS']).toBe(120);
  });

  it('TickBudgetTelemetry feeds the window from endTick', () => {
    const log = sink();
    const w = new TickHealthWindow(log, () => 'sec-e', fixedLag);
    const t = new TickBudgetTelemetry(w);
    let clock = 1_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      for (let i = 0; i < 25 * 11; i++) {
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
