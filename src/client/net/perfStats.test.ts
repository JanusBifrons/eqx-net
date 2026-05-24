/**
 * Unit lock for `perfStats.ts` (plan: perf-floor, Phase 1). Pure
 * functions, deterministic over synthetic `__eqxLogs` rings. The
 * load-bearing seam — Phase 5's perfBudget reads these fields off
 * `data-pred-stats`, so any compute drift here surfaces in the gate.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRollingRafStats,
  countRecentTagOccurrences,
  readHeapUsedMb,
  type LogEntry,
} from './perfStats.js';

function entry(ts: number, tag: string, data: Record<string, unknown> = {}): LogEntry {
  return { ts, tag, data };
}

function rafTick(ts: number, elapsedMs: number): LogEntry {
  return entry(ts, 'rafTick', { elapsedMs });
}

describe('computeRollingRafStats', () => {
  it('returns NaN p50/p99 when window has no samples', () => {
    const s = computeRollingRafStats([], 1000, 5000);
    expect(Number.isNaN(s.rafP50Ms)).toBe(true);
    expect(Number.isNaN(s.rafP99Ms)).toBe(true);
    expect(s.sampleCount).toBe(0);
  });

  it('filters by window — entries outside [now-windowMs, now] are dropped', () => {
    const entries = [
      rafTick(0, 16.7),       // outside window
      rafTick(1000, 100),     // outside window
      rafTick(6000, 16.7),    // inside (now=10000, window=5000 → cutoff=5000)
      rafTick(9999, 16.7),    // inside
    ];
    const s = computeRollingRafStats(entries, 10000, 5000);
    expect(s.sampleCount).toBe(2);
  });

  it('p50 is the median; p99 is the worst observed', () => {
    const entries: LogEntry[] = [];
    // 100 samples: 0..99 ms uniformly. p50 → 49 (nearest-rank: ceil(0.5*100)-1=49), p99 → 98 (ceil(0.99*100)-1=98).
    for (let i = 0; i < 100; i++) entries.push(rafTick(i, i));
    const s = computeRollingRafStats(entries, 200, 1000);
    expect(s.sampleCount).toBe(100);
    expect(s.rafP50Ms).toBe(49);
    expect(s.rafP99Ms).toBe(98);
  });

  it('ignores non-rafTick entries', () => {
    const entries = [
      rafTick(100, 16.7),
      entry(101, 'snapshot', { intervalMs: 50 }),
      entry(102, 'correction', { driftUnits: 0.1 }),
      rafTick(103, 25),
    ];
    const s = computeRollingRafStats(entries, 200, 1000);
    expect(s.sampleCount).toBe(2);
  });

  it('skips entries with non-numeric elapsedMs', () => {
    const entries = [
      rafTick(100, 16.7),
      entry(101, 'rafTick', { elapsedMs: 'oops' }),
      entry(102, 'rafTick', {}),
      rafTick(103, 25),
    ];
    const s = computeRollingRafStats(entries, 200, 1000);
    expect(s.sampleCount).toBe(2);
  });
});

describe('countRecentTagOccurrences', () => {
  it('counts entries with the given tag in window', () => {
    const entries = [
      entry(100, 'longtask', { durationMs: 60 }),
      entry(200, 'longtask', { durationMs: 120 }),
      entry(300, 'raf_gap', { elapsedMs: 200 }),
      entry(400, 'longtask', { durationMs: 80 }),
    ];
    expect(countRecentTagOccurrences(entries, 'longtask', 1000, 5000)).toBe(3);
    expect(countRecentTagOccurrences(entries, 'raf_gap', 1000, 5000)).toBe(1);
  });

  it('respects the window cutoff', () => {
    const entries = [
      entry(0, 'longtask', {}),     // outside
      entry(5000, 'longtask', {}),  // cutoff (now=10000, window=5000 → cutoff=5000)
      entry(7500, 'longtask', {}),  // inside
    ];
    expect(countRecentTagOccurrences(entries, 'longtask', 10000, 5000)).toBe(2);
  });

  it('returns 0 for unknown tag', () => {
    const entries = [entry(100, 'rafTick', {})];
    expect(countRecentTagOccurrences(entries, 'nonexistent', 1000, 5000)).toBe(0);
  });

  it('returns 0 for empty ring', () => {
    expect(countRecentTagOccurrences([], 'longtask', 1000, 5000)).toBe(0);
  });
});

describe('readHeapUsedMb', () => {
  it('returns undefined when perf is undefined', () => {
    expect(readHeapUsedMb(undefined)).toBe(undefined);
  });

  it('returns undefined when perf.memory is absent (Firefox / Safari)', () => {
    const perf = {} as Performance;
    expect(readHeapUsedMb(perf)).toBe(undefined);
  });

  it('returns MiB when perf.memory.usedJSHeapSize is a number (Chromium)', () => {
    const perf = {
      memory: { usedJSHeapSize: 50 * 1024 * 1024 },
    } as unknown as Performance;
    expect(readHeapUsedMb(perf)).toBe(50);
  });

  it('returns undefined when usedJSHeapSize is not a number', () => {
    const perf = { memory: {} } as unknown as Performance;
    expect(readHeapUsedMb(perf)).toBe(undefined);
  });
});
