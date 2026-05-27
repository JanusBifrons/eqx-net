/**
 * Unit tests for the GC-bench verdict module (plan: quirky-rabbit,
 * Phase 7-A).
 *
 * Mirrors the exhaustive locking pattern of `benchBudget.test.ts`:
 * every branch of `evaluateGcBench` gets a dedicated case so a future
 * change can't silently widen or remove a gate.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateGcBench,
  formatGcBenchVerdict,
  DEFAULT_GC_BENCH_BUDGET,
  type GcBenchSample,
} from './gcBenchBudget.js';

function sample(overrides: Partial<GcBenchSample> = {}): GcBenchSample {
  return {
    workload: 'swarm-tidi-30s',
    durationSec: 30,
    majorGcCount: 3,
    gcPauseTotalMs: 30,
    gcPauseMaxMs: 12,
    ...overrides,
  };
}

describe('evaluateGcBench', () => {
  describe('improvements never fail', () => {
    it('zero-everything head against any baseline passes', () => {
      const v = evaluateGcBench(
        sample({ majorGcCount: 0, gcPauseTotalMs: 0, gcPauseMaxMs: 0 }),
        sample(),
      );
      expect(v.pass).toBe(true);
      expect(v.failures).toEqual([]);
    });

    it('equal head and baseline passes', () => {
      expect(evaluateGcBench(sample(), sample()).pass).toBe(true);
    });
  });

  describe('relative AND absolute gate (both must breach)', () => {
    it('relative breach alone does not fail (still under absolute floor)', () => {
      // head 10×/30s = 0.33/sec, baseline 3×/30s = 0.1/sec.
      // Relative: 0.33 > 0.1×(1+0.5) = 0.15 → relative breach.
      // Absolute: 0.33 < countAbsoluteFloor (1.0) → no absolute breach.
      // Result: pass.
      const v = evaluateGcBench(
        sample({ majorGcCount: 10 }),
        sample({ majorGcCount: 3 }),
      );
      expect(v.pass).toBe(true);
    });

    it('absolute breach alone does not fail (within relative margin)', () => {
      // head 36×/30s = 1.2/sec (above abs floor 1.0), baseline 32×/30s = 1.067/sec.
      // Relative: 1.2 > 1.067×(1+0.5) = 1.6? No, 1.2 < 1.6 → no relative breach.
      // Result: pass.
      const v = evaluateGcBench(
        sample({ majorGcCount: 36 }),
        sample({ majorGcCount: 32 }),
      );
      expect(v.pass).toBe(true);
    });

    it('both relative AND absolute breach → fail on majorGcCount', () => {
      // head 60×/30s = 2.0/sec, baseline 3×/30s = 0.1/sec.
      // Relative: 2.0 > 0.15 ✓; Absolute: 2.0 > 1.0 ✓. Fail.
      const v = evaluateGcBench(
        sample({ majorGcCount: 60 }),
        sample({ majorGcCount: 3 }),
      );
      expect(v.pass).toBe(false);
      expect(v.failures).toHaveLength(1);
      expect(v.failures[0]!.metric).toBe('majorGcCount');
    });

    it('both gates breach on gcPauseTotalMs → fail', () => {
      // head 3000 ms/30s = 100 ms/sec, baseline 30 ms/30s = 1 ms/sec.
      // Relative: 100 > 1×1.5 = 1.5 ✓; Absolute: 100 > 50 ms/sec ✓.
      const v = evaluateGcBench(
        sample({ gcPauseTotalMs: 3000 }),
        sample({ gcPauseTotalMs: 30 }),
      );
      expect(v.pass).toBe(false);
      expect(v.failures.some((f) => f.metric === 'gcPauseTotalMs')).toBe(true);
    });

    it('both gates breach on gcPauseMaxMs → fail', () => {
      // head 80 ms, baseline 12 ms. Relative: 80 > 12×1.5 = 18 ✓;
      // Absolute: 80 > 30 ms ✓.
      const v = evaluateGcBench(
        sample({ gcPauseMaxMs: 80 }),
        sample({ gcPauseMaxMs: 12 }),
      );
      expect(v.pass).toBe(false);
      expect(v.failures.some((f) => f.metric === 'gcPauseMaxMs')).toBe(true);
    });
  });

  describe('preconditions', () => {
    it('workload key mismatch is a precondition failure', () => {
      const v = evaluateGcBench(
        sample({ workload: 'A' }),
        sample({ workload: 'B' }),
      );
      expect(v.pass).toBe(false);
      expect(v.preconditionFailures[0]).toMatch(/workload mismatch/);
    });

    it('head duration below MIN_DURATION_SEC is a precondition failure', () => {
      const v = evaluateGcBench(
        sample({ durationSec: 5, majorGcCount: 0, gcPauseTotalMs: 0, gcPauseMaxMs: 0 }),
        sample(),
      );
      expect(v.pass).toBe(false);
      expect(v.preconditionFailures.some((p) => p.includes('head.durationSec'))).toBe(true);
    });

    it('baseline duration below MIN_DURATION_SEC is a precondition failure', () => {
      const v = evaluateGcBench(
        sample(),
        sample({ durationSec: 5 }),
      );
      expect(v.pass).toBe(false);
      expect(v.preconditionFailures.some((p) => p.includes('baseline.durationSec'))).toBe(true);
    });
  });

  describe('rate normalisation', () => {
    it('compares per-second rates, not raw counts', () => {
      // head: 60 GCs in 60 s = 1/sec. baseline: 30 GCs in 30 s = 1/sec.
      // Same rate → pass even though raw counts differ 2:1.
      const v = evaluateGcBench(
        sample({ durationSec: 60, majorGcCount: 60, gcPauseTotalMs: 60, gcPauseMaxMs: 12 }),
        sample({ durationSec: 30, majorGcCount: 30, gcPauseTotalMs: 30, gcPauseMaxMs: 12 }),
      );
      expect(v.pass).toBe(true);
    });
  });

  describe('budget overrides', () => {
    it('a custom budget with tighter floor changes the verdict', () => {
      const tight = { ...DEFAULT_GC_BENCH_BUDGET, countAbsoluteFloor: 0.05 };
      // head 10/30s = 0.33/sec, baseline 3/30s = 0.1/sec.
      // Default: pass (head under default 1.0 floor).
      // Tight: 0.33 > 0.05 floor → absolute breach. 0.33 > 0.15 relative → relative breach. Fail.
      const v = evaluateGcBench(
        sample({ majorGcCount: 10 }),
        sample({ majorGcCount: 3 }),
        tight,
      );
      expect(v.pass).toBe(false);
    });
  });
});

describe('formatGcBenchVerdict', () => {
  it('includes "pass: true" for a clean verdict', () => {
    const text = formatGcBenchVerdict({
      pass: true,
      preconditionFailures: [],
      failures: [],
    });
    expect(text).toContain('pass: true');
  });

  it('includes the failure when one is present', () => {
    const text = formatGcBenchVerdict({
      pass: false,
      preconditionFailures: [],
      failures: [{
        workload: 'foo',
        metric: 'majorGcCount',
        headValue: 2.0,
        baselineValue: 0.5,
        ratio: 4.0,
      }],
    });
    expect(text).toContain('majorGcCount');
    expect(text).toContain('ratio=4.00');
  });
});
