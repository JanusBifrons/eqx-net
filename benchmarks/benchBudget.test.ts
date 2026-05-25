/**
 * Unit lock for the bench-budget decision core (plan: perf-floor, Phase 0).
 * Mirrors the matrix of `tests/netgate/netHealthBudget.test.ts`. Pure; no
 * IO; no vitest bench.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BENCH_BUDGET,
  evaluateBench,
  keyOf,
  normaliseVitestBench,
  type BenchSample,
} from './benchBudget.js';

function mk(over: Partial<BenchSample> = {}): BenchSample {
  return {
    file: 'benchmarks/x.bench.ts',
    group: 'g',
    name: 'b',
    hz: 1_000_000,
    mean: 0.001,
    p99: 0.002,
    sampleCount: 500_000,
    ...over,
  };
}

describe('evaluateBench', () => {
  it('improvement (head faster than baseline) PASSES', () => {
    const head = [mk({ hz: 2_000_000 })];
    const baseline = [mk({ hz: 1_000_000 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('within margin (head slower by 20%) PASSES — relative test does not breach', () => {
    const head = [mk({ hz: 800_000 })];
    const baseline = [mk({ hz: 1_000_000 })];
    // 800k > 1000k / 1.4 = 714k, so no relative breach.
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('relative breach without absolute breach PASSES (AND-gate)', () => {
    // head 200k, baseline 1M — relative breach (head < 1M / 1.4 = 714k),
    // but 200k still above DEFAULT hzFloor=1000, so absolute does NOT breach.
    const head = [mk({ hz: 200_000 })];
    const baseline = [mk({ hz: 1_000_000 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('absolute breach without relative breach PASSES (AND-gate)', () => {
    // head 500, baseline 600 — head < floor (1000), but relative
    // 500 / (600 / 1.4) = 500 / 428 = above; no relative breach.
    const head = [mk({ hz: 500 })];
    const baseline = [mk({ hz: 600 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('both breaches FAIL with metric+magnitude', () => {
    const head = [mk({ hz: 100 })];
    const baseline = [mk({ hz: 1_000_000 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(1);
    const f = v.failures[0]!;
    expect(f.metric).toBe('hz');
    expect(f.head).toBe(100);
    expect(f.baseline).toBe(1_000_000);
    expect(f.ratio).toBeGreaterThan(1);
    expect(f.kind).toBe('relative+absolute');
  });

  it('low sampleCount on HEAD is a precondition failure (not a regression)', () => {
    const head = [mk({ sampleCount: 10 })];
    const baseline = [mk()];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThan(0);
    expect(v.preconditionFailures[0]).toMatch(/HEAD/);
    expect(v.failures).toEqual([]);
  });

  it('low sampleCount on baseline is a precondition failure', () => {
    const head = [mk()];
    const baseline = [mk({ sampleCount: 5 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThan(0);
  });

  it('missing bench in HEAD is a precondition failure', () => {
    const head: BenchSample[] = [];
    const baseline = [mk()];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.some((p) => p.includes('missing from HEAD'))).toBe(true);
  });

  it('new bench in HEAD without baseline is a precondition failure', () => {
    const head = [mk()];
    const baseline: BenchSample[] = [];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.some((p) => p.includes('missing from baseline'))).toBe(true);
  });

  it('multiple benches: one fails, others pass', () => {
    const head = [mk({ name: 'a', hz: 100 }), mk({ name: 'b', hz: 2_000_000 })];
    const baseline = [mk({ name: 'a', hz: 1_000_000 }), mk({ name: 'b', hz: 1_000_000 })];
    const v = evaluateBench(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]!.key).toContain('a');
  });
});

describe('DEFAULT_BENCH_BUDGET', () => {
  it('has the documented relative+absolute pair', () => {
    expect(DEFAULT_BENCH_BUDGET.hzMargin).toBe(0.4);
    expect(DEFAULT_BENCH_BUDGET.hzFloor).toBe(1000);
  });
});

describe('keyOf', () => {
  it('joins file > group > name', () => {
    expect(keyOf(mk({ file: 'f', group: 'g', name: 'n' }))).toBe('f > g > n');
  });
});

describe('normaliseVitestBench', () => {
  it('extracts {file, group, name, hz, mean, p99, sampleCount} from vitest --outputJson shape', () => {
    const vitestShape = {
      files: [
        {
          filepath: '/abs/path/to/benchmarks/foo.bench.ts',
          groups: [
            {
              fullName: 'benchmarks/foo.bench.ts > group-name',
              benchmarks: [
                { name: 'bench-a', hz: 1_000_000, mean: 0.001, p99: 0.002, sampleCount: 500_000 },
                { name: 'bench-b', hz: 50_000, mean: 0.02, p99: 0.03, sampleCount: 25_000 },
              ],
            },
          ],
        },
      ],
    };
    const samples = normaliseVitestBench(vitestShape);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({
      file: 'benchmarks/foo.bench.ts',
      group: 'group-name',
      name: 'bench-a',
      hz: 1_000_000,
      mean: 0.001,
      p99: 0.002,
      sampleCount: 500_000,
    });
  });

  it('returns [] for non-record input', () => {
    expect(normaliseVitestBench(null)).toEqual([]);
    expect(normaliseVitestBench(undefined)).toEqual([]);
    expect(normaliseVitestBench(42)).toEqual([]);
  });

  it('returns [] when files key is missing', () => {
    expect(normaliseVitestBench({ other: 'shape' })).toEqual([]);
  });
});
