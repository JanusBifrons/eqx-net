/**
 * Unit lock for `tests/perf/perfBudget.ts` (plan: perf-floor, Phase 5).
 * Pure decision core, deterministic over synthetic arms. Mirrors the
 * test matrix of `tests/netgate/netHealthBudget.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePerf, PERF_BUDGET, MIN_SAMPLES, type PerfArm } from './perfBudget.js';

function arm(over: Partial<PerfArm> = {}): PerfArm {
  return {
    rafP50Ms: 16.7,
    rafP99Ms: 25,
    longtaskCount30s: 0,
    rafGapCount30s: 0,
    rollingCorrRate: 0.1,
    serverTickTotalAvgMs: 3,
    serverTickOverBudgetRatio: 0,
    sampleCount: MIN_SAMPLES + 10,
    diagEnabledAtCapture: false,
    ...over,
  };
}

describe('evaluatePerf — improvements never fail', () => {
  it('head better on every metric PASSES', () => {
    const head = arm({ rafP50Ms: 10, rafP99Ms: 15, longtaskCount30s: 0, rollingCorrRate: 0.05 });
    const baseline = arm({ rafP50Ms: 16.7, rafP99Ms: 25, longtaskCount30s: 1, rollingCorrRate: 0.1 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });
});

describe('evaluatePerf — relative+absolute AND-gate', () => {
  it('within relative margin PASSES even if ceiling crossed', () => {
    // head 16 ms p50, baseline 12 ms — relative test: 16 > 12 * 1.5 + 2 = 20? no.
    // So no relative breach.
    const head = arm({ rafP50Ms: 16 });
    const baseline = arm({ rafP50Ms: 12 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('relative breach without absolute breach PASSES', () => {
    // head 30 ms p50, baseline 10 ms — relative: 30 > 10 * 1.5 + 2 = 17 (breach).
    // absolute: 30 > 33.3? no. So AND-gate: PASS.
    const head = arm({ rafP50Ms: 30 });
    const baseline = arm({ rafP50Ms: 10 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('absolute breach without relative breach PASSES', () => {
    // head 40 ms p50, baseline 35 — absolute: 40 > 33.3 (breach).
    // relative: 40 > 35 * 1.5 + 2 = 54.5? no. PASS.
    const head = arm({ rafP50Ms: 40 });
    const baseline = arm({ rafP50Ms: 35 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('both breaches FAIL with metric+magnitude', () => {
    const head = arm({ rafP50Ms: 100 });
    const baseline = arm({ rafP50Ms: 16.7 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(1);
    const f = v.failures[0]!;
    expect(f.metric).toBe('rafP50Ms');
    expect(f.head).toBe(100);
    expect(f.baseline).toBe(16.7);
    expect(f.kind).toBe('relative+absolute');
    expect(f.ratio).toBeGreaterThan(5);
  });
});

describe('evaluatePerf — liveness preconditions', () => {
  it('HEAD sampleCount below MIN_SAMPLES is a precondition fail', () => {
    const head = arm({ sampleCount: 10 });
    const baseline = arm();
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThan(0);
    expect(v.preconditionFailures[0]).toMatch(/HEAD sampleCount/);
  });

  it('baseline sampleCount below MIN_SAMPLES is a precondition fail', () => {
    const head = arm();
    const baseline = arm({ sampleCount: 5 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures[0]).toMatch(/baseline sampleCount/);
  });

  it('HEAD diag ON is a precondition fail', () => {
    const head = arm({ diagEnabledAtCapture: true });
    const baseline = arm();
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.some((p) => p.includes('HEAD ran with diag'))).toBe(true);
  });

  it('baseline diag ON is a precondition fail', () => {
    const head = arm();
    const baseline = arm({ diagEnabledAtCapture: true });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.some((p) => p.includes('baseline ran with diag'))).toBe(true);
  });

  it('precondition fail does NOT prevent metric evaluation', () => {
    const head = arm({ sampleCount: 5, rafP50Ms: 100 });
    const baseline = arm({ rafP50Ms: 16.7 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThan(0);
    expect(v.failures.length).toBeGreaterThan(0); // both signals surface
  });
});

describe('evaluatePerf — NaN / edge cases', () => {
  it('NaN inputs are skipped (no fail, no throw)', () => {
    const head = arm({ rafP50Ms: Number.NaN });
    const baseline = arm({ rafP50Ms: 16.7 });
    const v = evaluatePerf(head, baseline);
    // Other metrics still PASS.
    expect(v.pass).toBe(true);
  });

  it('baseline=0 with head>0 falls back to absolute-only', () => {
    const head = arm({ longtaskCount30s: 100 });
    const baseline = arm({ longtaskCount30s: 0 });
    // longtaskCount30s ceil=10; head 100 > 10 (absolute breach).
    // baseline=0; relative threshold = 0*2 + 1 = 1; head 100 > 1 (relative breach).
    // Both breach ⇒ FAIL.
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.metric === 'longtaskCount30s')).toBe(true);
  });

  it('serverTickOverBudgetRatio strict ceiling — any rescue at ambient fails', () => {
    // ratio ceil = 0.1; head 0.5 means rescue engaged 50% of the time.
    const head = arm({ serverTickOverBudgetRatio: 0.5 });
    const baseline = arm({ serverTickOverBudgetRatio: 0 });
    const v = evaluatePerf(head, baseline);
    // baseline=0; relative threshold = 0*6 + 0.05 = 0.05; head 0.5 > 0.05 (breach).
    // absolute: 0.5 > 0.1 (breach). ⇒ FAIL.
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.metric === 'serverTickOverBudgetRatio')).toBe(true);
  });
});

describe('PERF_BUDGET shape', () => {
  it('every documented metric has a budget', () => {
    const expected = [
      'rafP50Ms',
      'rafP99Ms',
      'longtaskCount30s',
      'rafGapCount30s',
      'rollingCorrRate',
      'serverTickTotalAvgMs',
      'serverTickOverBudgetRatio',
    ];
    for (const k of expected) {
      const budget = (PERF_BUDGET as Record<string, unknown>)[k];
      expect(budget, `missing budget for ${k}`).toBeDefined();
    }
  });

  it('every budget has margin / eps / ceil', () => {
    for (const [name, b] of Object.entries(PERF_BUDGET)) {
      expect(typeof b.margin, `${name}.margin`).toBe('number');
      expect(typeof b.eps, `${name}.eps`).toBe('number');
      expect(typeof b.ceil, `${name}.ceil`).toBe('number');
      expect(b.margin, `${name}.margin >= 0`).toBeGreaterThanOrEqual(0);
      expect(b.eps, `${name}.eps >= 0`).toBeGreaterThanOrEqual(0);
      expect(b.ceil, `${name}.ceil > 0`).toBeGreaterThan(0);
    }
  });
});

describe('multiple metric failures', () => {
  it('reports all metrics that breach', () => {
    const head = arm({
      rafP50Ms: 100,
      rafP99Ms: 200,
      rollingCorrRate: 0.9,
    });
    const baseline = arm({ rafP50Ms: 16.7, rafP99Ms: 25, rollingCorrRate: 0.05 });
    const v = evaluatePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures.length).toBeGreaterThanOrEqual(3);
    const metrics = new Set(v.failures.map((f) => f.metric));
    expect(metrics.has('rafP50Ms')).toBe(true);
    expect(metrics.has('rafP99Ms')).toBe(true);
    expect(metrics.has('rollingCorrRate')).toBe(true);
  });
});
