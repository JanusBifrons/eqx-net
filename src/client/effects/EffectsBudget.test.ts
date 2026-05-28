/**
 * `EffectsBudget` regression locks. Plan M1 deliverable.
 *
 * Covers: EMA cold-start, warmup hold, every tier transition (down + up),
 * hysteresis (3× hold on upshift), `setQuality` push interaction with
 * `pickMoreRestrictiveQuality`, and the "constant load → zero transitions"
 * lock that backs the SET_EFFECT_QUALITY IPC-only-on-transition contract.
 */

import { describe, expect, it } from 'vitest';
import { BUDGET_THRESHOLDS, EffectsBudget } from './EffectsBudget';

/** Helper: feed N samples of `rendererUpdateMs = ms`, each with `dtMs = 16.67`. */
function feed(b: EffectsBudget, ms: number, frames: number): void {
  for (let i = 0; i < frames; i++) b.sample({ rendererUpdateMs: ms, dtMs: 16.67 });
}

describe('EffectsBudget — cold start', () => {
  it('holds at high while under warmupSamples count', () => {
    const b = new EffectsBudget();
    for (let i = 0; i < BUDGET_THRESHOLDS.warmupSamples - 1; i++) {
      b.sample({ rendererUpdateMs: 1000, dtMs: 16.67 });
    }
    expect(b.getLocalTier()).toBe('high');
  });

  it('initial EMA is NaN, becomes finite after first sample', () => {
    const b = new EffectsBudget();
    expect(Number.isNaN(b.getEmaMs())).toBe(true);
    b.sample({ rendererUpdateMs: 5, dtMs: 16.67 });
    expect(b.getEmaMs()).toBeCloseTo(5);
  });
});

describe('EffectsBudget — downshift transitions', () => {
  it('high → medium (≥ 6 ms for 500 ms): just-over-threshold + sufficient hold', () => {
    const b = new EffectsBudget();
    // Just-over threshold (6.5 ms): only crosses high_to_medium, not the
    // tighter medium_to_low (8). Frames = warmup (8) + dwell (≥ 30 for 500 ms)
    // + slack. 45 frames is comfortably past both.
    feed(b, 6.5, 45);
    expect(b.getLocalTier()).toBe('medium');
  });

  it('high → medium does NOT trigger before 500 ms dwell (post-warmup)', () => {
    const b = new EffectsBudget();
    // warmup (8) + 20 frames dwell = ~333 ms, well under 500 ms.
    feed(b, 6.5, 28);
    expect(b.getLocalTier()).toBe('high');
  });

  it('medium → low (≥ 8 ms for 500 ms): cascades from cold start at constant 8.5 ms', () => {
    const b = new EffectsBudget();
    // 8.5 ms crosses high_to_medium (6) AND medium_to_low (8) but stays
    // under low_to_minimal (9). Cascade: high → medium (~500 ms) → low (~500 ms).
    feed(b, 8.5, 100); // ~1670 ms — enough for both transitions
    expect(b.getLocalTier()).toBe('low');
  });

  it('low → minimal (≥ 9 ms for 250 ms): full cascade at constant 10 ms reaches minimal', () => {
    const b = new EffectsBudget();
    // 10 ms triggers all three downshifts. Cascade takes ~1.25 s total
    // (500 + 500 + 250 ms).
    feed(b, 10, 120);
    expect(b.getLocalTier()).toBe('minimal');
  });

  it('minimal does NOT downshift further (floor)', () => {
    const b = new EffectsBudget();
    feed(b, 50, 200);
    expect(b.getLocalTier()).toBe('minimal');
    feed(b, 50, 200);
    expect(b.getLocalTier()).toBe('minimal');
  });
});

describe('EffectsBudget — upshift hysteresis (3× hold)', () => {
  it('fully recovers minimal → high under sustained quiet load (constant input)', () => {
    const b = new EffectsBudget();
    feed(b, 50, 200); // → minimal
    expect(b.getLocalTier()).toBe('minimal');

    // Recovery takes time: each upshift requires a fresh dwell window after the
    // previous transition resets the dwell counter. With dt=16.67 ms:
    //   minimal → low: ~750 ms (45 frames) AFTER ema decays under 7 (≈30 frames)
    //   low → medium: 1500 ms (90 frames)
    //   medium → high: 1500 ms (90 frames)
    // Total: ~255 frames worst case from start of recovery to reaching high.
    feed(b, 1, 500);
    expect(b.getLocalTier()).toBe('high');
  });

  it('upshift respects dwell: interrupted recovery does NOT advance to a higher tier', () => {
    const b = new EffectsBudget();
    // Get into low so we can test the low → medium upshift (needs ema < 6 for 1500 ms).
    feed(b, 8.5, 100);
    expect(b.getLocalTier()).toBe('low');

    // Now feed quiet load (1 ms) for 80 frames (~1333 ms) — under 1500 ms hold.
    // Even though the EMA has decayed below 6 ms, the dwell hasn't accumulated
    // enough for the upshift.
    feed(b, 1, 80);
    expect(b.getLocalTier()).toBe('low');
  });
});

describe('EffectsBudget — IPC-only-on-transition guarantee', () => {
  it('100 frames at constant low load → zero transitions from high', () => {
    const b = new EffectsBudget();
    let transitions = 0;
    let prev = b.getLocalTier();
    for (let i = 0; i < 100; i++) {
      b.sample({ rendererUpdateMs: 2, dtMs: 16.67 });
      if (b.getLocalTier() !== prev) {
        transitions++;
        prev = b.getLocalTier();
      }
    }
    expect(transitions).toBe(0);
  });

  it('100 frames at constant high load → exactly one transition (high→medium)', () => {
    const b = new EffectsBudget();
    let transitions = 0;
    let prev: string = b.getLocalTier();
    for (let i = 0; i < 100; i++) {
      b.sample({ rendererUpdateMs: 7, dtMs: 16.67 });
      const cur = b.getLocalTier();
      if (cur !== prev) {
        transitions++;
        prev = cur;
      }
    }
    expect(transitions).toBe(1);
    expect(b.getLocalTier()).toBe('medium');
  });
});

describe('EffectsBudget — pushed quality interaction', () => {
  it('getQuality = min(local, pushed) — pushed lower wins', () => {
    const b = new EffectsBudget();
    feed(b, 1, 20); // local stays at high
    b.setQuality('low');
    expect(b.getQuality()).toBe('low');
    expect(b.getLocalTier()).toBe('high'); // local is unchanged
  });

  it('getQuality = min(local, pushed) — local lower wins', () => {
    const b = new EffectsBudget();
    feed(b, 12, 60); // local → medium
    b.setQuality('high'); // push high (less restrictive)
    expect(b.getQuality()).toBe('medium');
  });
});

describe('EffectsBudget — getStats', () => {
  it('getStats returns the live tier + counters', () => {
    const b = new EffectsBudget();
    b.recordCounts({ activeBursts: 3, activeContinuous: 7, activeFilters: 1 });
    const s = b.getStats();
    expect(s.activeBursts).toBe(3);
    expect(s.activeContinuous).toBe(7);
    expect(s.activeFilters).toBe(1);
    expect(s.quality).toBe('high');
  });

  it('getStats does NOT allocate (returns the same object reference)', () => {
    const b = new EffectsBudget();
    expect(b.getStats()).toBe(b.getStats());
  });
});
