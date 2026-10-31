/**
 * Unit lock for `tests/perf/perfCapture.ts` (plan: perf-floor, Phase 2).
 * Pure aggregator, deterministic over synthetic samples.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateSamples,
  framePercentile,
  parseTickBudgetEvent,
  type PerSampleArm,
  type TickBudgetSample,
} from './perfCapture.js';

function s(over: Partial<PerSampleArm> = {}): PerSampleArm {
  return {
    tMs: 0,
    rafP50Ms: 16.7,
    rafP99Ms: 25,
    longtaskCount30s: 0,
    rafGapCount30s: 0,
    heapUsedMb: 50,
    rollingCorrRate: 0.1,
    maxDriftUnits: 1.5,
    meanDriftUnits: 0.5,
    ticksAhead: 4,
    snapshotCount: 100,
    diagEnabled: false,
    ...over,
  };
}

const NOW = '2026-05-20T20:00:00.000Z';

describe('aggregateSamples', () => {
  it('produces median/p95/p99 per metric over the sample series', () => {
    const samples: PerSampleArm[] = [];
    for (let i = 0; i < 100; i++) samples.push(s({ tMs: i * 200, rafP50Ms: 10 + i }));
    const agg = aggregateSamples({
      scenario: 'sol-prime-ambient',
      arm: 'desktop',
      durationMs: 25_000,
      samples,
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.sampleCount).toBe(100);
    // 100 samples uniformly 10..109: nearest-rank median=109+10-ceil(0.5*100)+1
    // Actually nearest-rank picks index ceil(0.5*100)-1 = 49. samples[49] = 10+49 = 59.
    expect(agg.metrics['rafP50Ms']!.median).toBe(59);
    // p95 → index ceil(0.95*100)-1 = 94 → 10+94 = 104.
    expect(agg.metrics['rafP50Ms']!.p95).toBe(104);
    expect(agg.metrics['rafP50Ms']!.p99).toBe(108);
  });

  it('NaN samples are dropped from per-metric series', () => {
    const samples = [
      s({ rafP50Ms: 16.7 }),
      s({ rafP50Ms: Number.NaN }),
      s({ rafP50Ms: 25 }),
    ];
    const agg = aggregateSamples({
      scenario: 'x',
      arm: 'desktop',
      durationMs: 1000,
      samples,
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.metrics['rafP50Ms']!.sampleCount).toBe(2);
  });

  it('heapUsedMb skipped when no Chromium samples', () => {
    const samples = [s({ heapUsedMb: undefined }), s({ heapUsedMb: undefined })];
    const agg = aggregateSamples({
      scenario: 'x',
      arm: 'desktop',
      durationMs: 1000,
      samples,
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.metrics['heapUsedMb']).toBeUndefined();
  });

  it('diagEnabledAtCapture is true if ANY sample reports diag on', () => {
    const samples = [s(), s({ diagEnabled: true }), s()];
    const agg = aggregateSamples({
      scenario: 'x',
      arm: 'desktop',
      durationMs: 1000,
      samples,
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.diagEnabledAtCapture).toBe(true);
  });

  it('tickBudget aggregates weighted-average + max + ratio', () => {
    const tickBudgets: TickBudgetSample[] = [
      { serverTick: 100, total: 5, overBudgetCount: 0, sampleCount: 60 },
      { serverTick: 160, total: 6, overBudgetCount: 2, sampleCount: 60 },
      { serverTick: 220, total: 10, overBudgetCount: 5, sampleCount: 60 },
    ];
    const agg = aggregateSamples({
      scenario: 'x',
      arm: 'desktop',
      durationMs: 1000,
      samples: [s()],
      tickBudgets,
      capturedAt: NOW,
    });
    expect(agg.tickBudget.sampleCount).toBe(3);
    // weighted avg = (5*60 + 6*60 + 10*60) / 180 = 21/3 = 7
    expect(agg.tickBudget.totalAvgMs).toBeCloseTo(7, 6);
    expect(agg.tickBudget.totalMaxMs).toBe(10);
    // overBudgetRatio = (0+2+5)/(60+60+60) = 7/180
    expect(agg.tickBudget.overBudgetRatio).toBeCloseTo(7 / 180, 6);
  });

  it('empty tick budgets → zeros, no NaN', () => {
    const agg = aggregateSamples({
      scenario: 'x',
      arm: 'desktop',
      durationMs: 1000,
      samples: [s()],
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.tickBudget.sampleCount).toBe(0);
    expect(agg.tickBudget.totalAvgMs).toBe(0);
    expect(agg.tickBudget.totalMaxMs).toBe(0);
    expect(agg.tickBudget.overBudgetRatio).toBe(0);
  });

  it('population is included when passed, omitted otherwise', () => {
    const withPop = aggregateSamples({
      scenario: 'sol-prime-ambient',
      arm: 'desktop',
      durationMs: 1000,
      samples: [s()],
      tickBudgets: [],
      capturedAt: NOW,
      population: { hunters: 25, totalDrones: 39 },
    });
    expect(withPop.population).toEqual({ hunters: 25, totalDrones: 39 });

    const withoutPop = aggregateSamples({
      scenario: 'feel-test-25',
      arm: 'desktop',
      durationMs: 1000,
      samples: [s()],
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(withoutPop.population).toBeUndefined();
  });

  it('preserves scenario / arm / durationMs / capturedAt verbatim', () => {
    const agg = aggregateSamples({
      scenario: 'sol-prime-ambient',
      arm: 'mobile-shaped',
      durationMs: 25_000,
      samples: [s()],
      tickBudgets: [],
      capturedAt: NOW,
    });
    expect(agg.scenario).toBe('sol-prime-ambient');
    expect(agg.arm).toBe('mobile-shaped');
    expect(agg.durationMs).toBe(25_000);
    expect(agg.capturedAt).toBe(NOW);
  });
});

// The EXACT payload `TickBudgetTelemetry.endTick` emits (src/server/rooms/
// TickBudgetTelemetry.ts — serverLogEvent('tick_budget', …)). Kept literal so a
// drift in either side fails here rather than silently zeroing the baseline.
const REAL_TICK_BUDGET_EVENT = {
  serverTick: 1200,
  sampleCount: 60,
  avgMs: { total: 3.25, physics: 1.1, broadcast: 0.9 },
  maxTotalMs: 8.5,
  overBudgetCount: 0,
  playerCount: 1,
  swarmCount: 25,
  aiSize: 25,
};

describe('parseTickBudgetEvent', () => {
  it('reads avgMs.total + maxTotalMs from the real server event shape', () => {
    // Regression: the old parser required a top-level `total` (never emitted)
    // so every real event was dropped → baselines recorded sampleCount 0.
    expect(parseTickBudgetEvent(REAL_TICK_BUDGET_EVENT)).toEqual({
      serverTick: 1200,
      total: 3.25,
      maxTotalMs: 8.5,
      overBudgetCount: 0,
      sampleCount: 60,
    });
  });

  it('drops events from rooms with no live player (the global ring mixes ~21 galaxy rooms)', () => {
    expect(parseTickBudgetEvent({ ...REAL_TICK_BUDGET_EVENT, playerCount: 0 })).toBeNull();
  });

  it('rejects malformed events', () => {
    expect(parseTickBudgetEvent({ ...REAL_TICK_BUDGET_EVENT, avgMs: {} })).toBeNull();
    expect(parseTickBudgetEvent({ serverTick: 1 })).toBeNull();
  });

  it('aggregate uses maxTotalMs for the worst tick, not the window average', () => {
    const tb = parseTickBudgetEvent(REAL_TICK_BUDGET_EVENT)!;
    const agg = aggregateSamples({
      scenario: 's',
      arm: 'desktop',
      durationMs: 1000,
      samples: [],
      tickBudgets: [tb],
      capturedAt: '2026-10-31T00:00:00.000Z',
    });
    expect(agg.tickBudget.totalAvgMs).toBe(3.25);
    expect(agg.tickBudget.totalMaxMs).toBe(8.5);
  });
});

describe('framePercentile', () => {
  it('nearest-rank p50/p99 over unsorted frame deltas', () => {
    const d = [16, 17, 16, 33, 16, 16, 17, 16, 16, 100];
    expect(framePercentile(d, 0.5)).toBe(16);
    expect(framePercentile(d, 0.99)).toBe(100);
    expect(Number.isNaN(framePercentile([], 0.5))).toBe(true);
  });
});
