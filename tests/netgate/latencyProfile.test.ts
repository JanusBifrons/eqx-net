/**
 * Phase 1 / Mechanism 2 (plan: e2e-rebuild) — the deterministic WS
 * latency+jitter profile, written FIRST.
 *
 * The netcode gate injects a FIXED, reproducible adverse network so the
 * dominant variable is the injected RTT (≈120 ms ±60, from the incident
 * captures), NOT the host CPU. That reproducibility is this pure module's
 * entire job, so it is locked before the proxy that consumes it.
 *
 * NO PACKET DROP. The Colyseus WS is tunneled over TCP; dropping bytes at
 * an application proxy does not model packet loss — it corrupts the WS
 * frame stream and kills the connection. A TCP-faithful adverse network
 * is latency + jitter with ORDERED delivery (byte order preserved; the
 * proxy enforces that). Variable inter-arrival from jitter is what
 * stresses the netcode (snapshot-interval variance → snapshotJitterMs /
 * lookahead). The acceptance "injected network regression" is therefore
 * a much WORSE latency/jitter profile, never drops.
 *
 * Load-bearing determinism asserted here:
 *   - same seed ⇒ byte-identical delay sequence (the A==B-modulo-code
 *     guarantee Mechanism 3 leans on);
 *   - the two directions are independent streams (c2s ≠ s2c);
 *   - symmetric uniform jitter ⇒ mean → base; never-negative (clamped).
 *
 * Level: pure seeded math, zero IO — a node unit test is the faithful
 * lock. RED today: the module does not exist.
 */
import { describe, expect, it } from 'vitest';
import {
  LatencyScheduler,
  makeSeededRng,
  PROFILE_PRIMARY,
  PROFILE_REGRESSION_INJECT,
  type LatencyProfileSpec,
} from './latencyProfile';

describe('makeSeededRng — auditable mulberry32 (copied, NOT imported from src/server)', () => {
  it('is deterministic per seed and stays in [0,1)', () => {
    const a = makeSeededRng(12345);
    const b = makeSeededRng(12345);
    const seqA = Array.from({ length: 64 }, () => a());
    const seqB = Array.from({ length: 64 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const r of seqA) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBeGreaterThan(50); // not a constant stream
  });

  it('different seeds diverge', () => {
    const a = makeSeededRng(1);
    const b = makeSeededRng(2);
    expect(Array.from({ length: 16 }, () => a())).not.toEqual(
      Array.from({ length: 16 }, () => b()),
    );
  });
});

describe('PROFILE constants', () => {
  it('PRIMARY = ≈120 ms RTT ±60, the only profile the real gate uses', () => {
    expect(PROFILE_PRIMARY.baseMs).toBe(60);
    expect(PROFILE_PRIMARY.jitterMs).toBe(30);
  });

  it('REGRESSION_INJECT is unambiguously worse (acceptance self-test ONLY), TCP-safe (no drop concept)', () => {
    expect(PROFILE_REGRESSION_INJECT.baseMs).toBeGreaterThan(PROFILE_PRIMARY.baseMs);
    expect(PROFILE_REGRESSION_INJECT.jitterMs).toBeGreaterThan(PROFILE_PRIMARY.jitterMs);
    // No drop knob exists anywhere — byte-drop would corrupt the WS stream.
    expect((PROFILE_PRIMARY as Record<string, unknown>)['dropProb']).toBeUndefined();
    expect((PROFILE_REGRESSION_INJECT as Record<string, unknown>)['dropProb']).toBeUndefined();
  });
});

describe('LatencyScheduler.delayFor — deterministic, symmetric, clamped', () => {
  it('PRIMARY: all one-way delays in [base-jitter, base+jitter], mean → base', () => {
    const s = new LatencyScheduler(PROFILE_PRIMARY);
    const n = 1000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = s.delayFor('c2s');
      expect(d).toBeGreaterThanOrEqual(30);
      expect(d).toBeLessThanOrEqual(90);
      sum += d;
    }
    const mean = sum / n;
    expect(mean).toBeGreaterThan(58);
    expect(mean).toBeLessThan(62); // symmetric uniform jitter ⇒ E[delay]=base=60
  });

  it('same seed ⇒ byte-identical sequence (the A==B determinism guarantee)', () => {
    const a = new LatencyScheduler(PROFILE_PRIMARY);
    const b = new LatencyScheduler(PROFILE_PRIMARY);
    const seqA = Array.from({ length: 200 }, () => a.delayFor('s2c'));
    const seqB = Array.from({ length: 200 }, () => b.delayFor('s2c'));
    expect(seqA).toEqual(seqB);
  });

  it('the two directions are independent streams (c2s ≠ s2c)', () => {
    const s = new LatencyScheduler(PROFILE_PRIMARY);
    const c2s = Array.from({ length: 100 }, () => s.delayFor('c2s'));
    const s2 = new LatencyScheduler(PROFILE_PRIMARY);
    const s2c = Array.from({ length: 100 }, () => s2.delayFor('s2c'));
    expect(c2s).not.toEqual(s2c);
  });

  it('never returns a negative delay (clamped at 0 when jitter > base)', () => {
    const spec: LatencyProfileSpec = { ...PROFILE_PRIMARY, baseMs: 10, jitterMs: 30 };
    const s = new LatencyScheduler(spec);
    let sawZero = false;
    for (let i = 0; i < 2000; i++) {
      const d = s.delayFor('c2s');
      expect(d).toBeGreaterThanOrEqual(0);
      if (d === 0) sawZero = true;
    }
    expect(sawZero).toBe(true); // the [-20,40] range does clamp sometimes
  });

  it('REGRESSION_INJECT produces a materially higher mean than PRIMARY (same call count)', () => {
    const p = new LatencyScheduler(PROFILE_PRIMARY);
    const r = new LatencyScheduler(PROFILE_REGRESSION_INJECT);
    const meanOf = (s: LatencyScheduler): number => {
      let sum = 0;
      for (let i = 0; i < 500; i++) sum += s.delayFor('c2s');
      return sum / 500;
    };
    expect(meanOf(r)).toBeGreaterThan(meanOf(p) + 50);
  });
});
