import { describe, it, expect } from 'vitest';
import {
  updateAnchor,
  CLOCK_ANCHOR_EWMA_ALPHA,
  CLOCK_ANCHOR_HARD_SNAP_MS,
  type AnchorState,
} from './clockAnchor.js';

const FIXED_MS = 1000 / 60;

/** What `targetTick` the client would compute at `nowMs`, given an anchor.
 *  Mirrors the formula in ColyseusClient.tickPhysics(). leadTicks is fixed
 *  for the test — the EWMA effect is independent of it. */
function targetTickAt(anchor: AnchorState, nowMs: number, leadTicks = 6): number {
  return anchor.anchorServerTick + Math.floor((nowMs - anchor.anchorPerfNow) / FIXED_MS) + leadTicks;
}

describe('updateAnchor (Phase 6.5 EWMA clock anchor)', () => {
  it('first snapshot anchors directly with no drift', () => {
    const prev: AnchorState = { anchorServerTick: 100, anchorPerfNow: 1000 };
    const next = updateAnchor(prev, 100, 1000); // no drift
    expect(next.anchorServerTick).toBe(100);
    expect(next.anchorPerfNow).toBe(1000);
  });

  it('rebases anchorServerTick to the snapshot tick', () => {
    const prev: AnchorState = { anchorServerTick: 100, anchorPerfNow: 1000 };
    // snapshot 60 ticks later; perfNow exactly 60 × 16.67 ms = 1000 ms later.
    const next = updateAnchor(prev, 160, 2000);
    expect(next.anchorServerTick).toBe(160);
    // Zero drift → anchor PerfNow stays on the same line.
    expect(next.anchorPerfNow).toBeCloseTo(2000, 1);
  });

  it('blends anchorPerfNow toward the snapshot perfNow at alpha', () => {
    const prev: AnchorState = { anchorServerTick: 100, anchorPerfNow: 1000 };
    // snapshot at tick 101, expected at perfNow=1016.67, but actually arrived
    // 30 ms late at perfNow=1046.67. Drift = +30 ms.
    const next = updateAnchor(prev, 101, 1046.67);
    // Equivalent anchor on existing line at tick 101 = 1000 + 16.67 = 1016.67.
    // EWMA: 1016.67 * 0.9 + 1046.67 * 0.1 = 1019.67.
    expect(next.anchorPerfNow).toBeCloseTo(1016.67 + 30 * CLOCK_ANCHOR_EWMA_ALPHA, 2);
  });

  it('snaps when drift exceeds CLOCK_ANCHOR_HARD_SNAP_MS', () => {
    const prev: AnchorState = { anchorServerTick: 100, anchorPerfNow: 1000 };
    // Snapshot tick 101 expected at perfNow=1016.67; arrived at 1300 (drift +283 ms).
    const next = updateAnchor(prev, 101, 1300);
    // Hard-snap → anchorPerfNow = snapPerfNow exactly.
    expect(next.anchorPerfNow).toBe(1300);
  });

  it('absorbs ±30 ms arrival jitter — anchor PerfNow variance stays bounded', () => {
    // Simulate 50 snapshots at server-side 60 Hz (broadcast every 3 ticks =
    // nominal 50 ms inter-arrival) with ±30 ms random arrival jitter. The
    // EWMA anchor should converge so `anchor.anchorPerfNow` tracks the
    // *moving average* of arrival times, not the latest noisy one.
    //
    // Property: vs the snap-on-every-arrival baseline (no smoothing), the
    // anchor moves much less per snapshot. We assert the EWMA's per-snapshot
    // anchor PerfNow change is at most α × jitterMs in magnitude.
    let anchor: AnchorState = updateAnchor({ anchorServerTick: 0, anchorPerfNow: 0 }, 0, 0);

    const nominalIntervalMs = 50;
    const jitterMs = 30;
    let serverTick = 3;
    let nominalArrival = nominalIntervalMs;

    // mulberry32 for deterministic jitter.
    let seed = 0xdeadbeef >>> 0;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let r = seed;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };

    // Track per-snapshot adjustment magnitude — the (smoothed) drift the EWMA
    // applied each step. Should never exceed α × jitter (3 ms at α=0.1, jitter=30).
    let maxAnchorAdjust = 0;
    for (let i = 0; i < 50; i++) {
      const arrivalJitter = (rand() * 2 - 1) * jitterMs;
      const arrivalMs = nominalArrival + arrivalJitter;
      const before = anchor;
      anchor = updateAnchor(before, serverTick, arrivalMs);
      // The EWMA's adjustment is how far `anchorPerfNow` moved off the
      // current clock-line, normalised to the line's frame-of-reference.
      const equivalent = before.anchorPerfNow + (serverTick - before.anchorServerTick) * FIXED_MS;
      const adjust = Math.abs(anchor.anchorPerfNow - equivalent);
      if (i > 5 && adjust > maxAnchorAdjust) maxAnchorAdjust = adjust;
      serverTick += 3;
      nominalArrival += nominalIntervalMs;
    }
    // Per-step adjustment is α × (jitter + residual offset accumulated by the
    // EWMA's incomplete convergence between samples). Theoretical α × jitter
    // is 3 ms, but the residual can add up to ~α × jitter on top in steady
    // state. Bound conservatively at 2× the noise-free ideal — that's still
    // ~10× tighter than the snap-on-every-snapshot baseline (30 ms).
    expect(maxAnchorAdjust).toBeLessThanOrEqual(jitterMs * CLOCK_ANCHOR_EWMA_ALPHA * 2);
  });

  it('targetTick deltas at constant render cadence stay near the ideal', () => {
    // Render at a steady 60 Hz wall-clock; arrivals jitter ±30 ms. With
    // EWMA-smoothed anchor, adjacent `targetTick` deltas at constant render
    // times should be ≤ 1 tick (the reconciler tolerates that). Without
    // smoothing this would burst to ±2 ticks under the same input.
    let anchor: AnchorState = updateAnchor({ anchorServerTick: 0, anchorPerfNow: 0 }, 0, 0);
    const nominalIntervalMs = 50;
    const jitterMs = 30;

    let seed = 0x12345678 >>> 0;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let r = seed;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };

    // Pre-feed 30 snapshots so EWMA converges before we start sampling.
    let serverTick = 3;
    let nominalArrival = nominalIntervalMs;
    let lastFedNow = 0;
    for (let i = 0; i < 30; i++) {
      const arrivalMs = nominalArrival + (rand() * 2 - 1) * jitterMs;
      anchor = updateAnchor(anchor, serverTick, arrivalMs);
      lastFedNow = arrivalMs;
      serverTick += 3;
      nominalArrival += nominalIntervalMs;
    }

    // Sample targetTick at 60 Hz wall-clock starting just after the last fed
    // snapshot. New snapshots interleave at their nominal-jittered times.
    let renderNow = lastFedNow + 16.67;
    const samples: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      // Feed any snapshot that would have arrived by `renderNow`.
      while (nominalArrival - jitterMs <= renderNow) {
        const arrivalMs = nominalArrival + (rand() * 2 - 1) * jitterMs;
        if (arrivalMs > renderNow) break;
        anchor = updateAnchor(anchor, serverTick, arrivalMs);
        serverTick += 3;
        nominalArrival += nominalIntervalMs;
      }
      samples.push(targetTickAt(anchor, renderNow));
      renderNow += 16.67;
    }
    let maxDelta = 0;
    let minDelta = Number.POSITIVE_INFINITY;
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i]! - samples[i - 1]!;
      if (d > maxDelta) maxDelta = d;
      if (d < minDelta) minDelta = d;
    }
    // Ideal: targetTick advances by ~1 per render frame at 60 Hz. EWMA-
    // smoothed anchor should keep adjacent deltas in {0, 1, 2} — never the
    // {-2, +3} bursts the snap-on-every-arrival baseline produces.
    expect(maxDelta).toBeLessThanOrEqual(2);
    expect(minDelta).toBeGreaterThanOrEqual(0);
  });

  it('does not drift over long sessions (anchor stays on the right clock-line)', () => {
    // 1000 snapshots at 60 Hz with no jitter. Anchor should stay perfectly on
    // the line — no accumulated bias from the EWMA's blend.
    let anchor: AnchorState = { anchorServerTick: 0, anchorPerfNow: 0 };
    anchor = updateAnchor(anchor, 0, 0);
    let serverTick = 3;
    let arrivalMs = 50;
    for (let i = 0; i < 1000; i++) {
      anchor = updateAnchor(anchor, serverTick, arrivalMs);
      serverTick += 3;
      arrivalMs += 50;
    }
    // After 1000 snapshots, the anchor's implied tick at the latest perfNow
    // should equal serverTick (within rounding).
    const t = targetTickAt(anchor, arrivalMs - 50, /* leadTicks = */ 0);
    expect(Math.abs(t - (serverTick - 3))).toBeLessThanOrEqual(1);
  });

  it('CLOCK_ANCHOR_HARD_SNAP_MS is past typical jitter but well under network freezes', () => {
    // Sanity: 30 ms jitter (typical) shouldn't snap; 200 ms drift (≥ HARD_SNAP) does.
    expect(CLOCK_ANCHOR_HARD_SNAP_MS).toBeGreaterThan(50);
    expect(CLOCK_ANCHOR_HARD_SNAP_MS).toBeLessThan(1000);
  });
});
