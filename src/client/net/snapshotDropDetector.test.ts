/**
 * Stage 4 cycles 5 + 6 of the network-feel roadmap. Pure-function tests
 * for the snapshot-drop detector + adaptive-interp-bias controller.
 *
 * The server broadcasts a snapshot every 3 ticks (20 Hz at 60 Hz physics).
 * Each snapshot's `serverTick` is monotonically increasing — successive
 * arrivals should differ by 3 ticks. A larger gap is evidence the wire
 * dropped one or more snapshots somewhere between worker → main → wire →
 * client. The detector counts those gaps and biases the swarm-interp
 * delay upward to absorb the resulting visual jitter; a clean window
 * decays the bias back to floor.
 */
import { describe, it, expect } from 'vitest';
import {
  createDropDetector,
  observeSnapshotTick,
  computeInterpBiasMs,
} from './snapshotDropDetector.js';

describe('snapshotDropDetector', () => {
  it('Cycle 5: clean snapshots produce zero drop count', () => {
    const d = createDropDetector();
    // Snapshots arriving every 3 server ticks (the broadcast cadence).
    observeSnapshotTick(d, 100);
    observeSnapshotTick(d, 103);
    observeSnapshotTick(d, 106);
    observeSnapshotTick(d, 109);
    expect(d.dropCount).toBe(0);
  });

  it('Cycle 5: a tick gap > 3 increments the drop counter by the inferred drops', () => {
    const d = createDropDetector();
    observeSnapshotTick(d, 100);
    // Next snapshot should be tick 103. Receiving tick 109 implies 2
    // dropped snapshots (the ones that would have been at 103 and 106).
    observeSnapshotTick(d, 109);
    expect(d.dropCount).toBe(2);
  });

  it('Cycle 5: out-of-order or backwards ticks do not register as drops', () => {
    const d = createDropDetector();
    observeSnapshotTick(d, 100);
    // Server sometimes resends or the wire reorders — tick going
    // backwards/equal should be silently ignored, not counted.
    observeSnapshotTick(d, 100);
    observeSnapshotTick(d, 99);
    expect(d.dropCount).toBe(0);
  });

  it('Cycle 5: drop window slides over recent snapshots', () => {
    // The detector tracks drops only in the last N snapshots so a single
    // event in the distant past doesn't permanently inflate interp delay.
    // Default window: 10 snapshots.
    const d = createDropDetector({ windowSize: 10 });
    observeSnapshotTick(d, 100);
    observeSnapshotTick(d, 109); // 2 drops registered
    expect(d.dropCount).toBe(2);
    // Push 10 more clean snapshots; the early drop should age out.
    for (let i = 0; i < 10; i++) observeSnapshotTick(d, 109 + (i + 1) * 3);
    expect(d.dropCount).toBe(0);
  });

  it('Cycle 6: computeInterpBiasMs adds 1 tick × dropCount of bias to the floor', () => {
    // No drops → no bias.
    expect(computeInterpBiasMs(0)).toBe(0);
    // 1 drop in window → 1 frame (16.67 ms) of additional buffer.
    expect(computeInterpBiasMs(1)).toBeCloseTo(16.67, 1);
    // 5 drops → ~83 ms of additional buffer.
    expect(computeInterpBiasMs(5)).toBeCloseTo(83.33, 1);
  });

  it('Cycle 6: computeInterpBiasMs caps at a sane maximum', () => {
    // A pathological run of drops shouldn't push the buffer past the
    // ceiling — there's no point speculating arbitrarily far back.
    const huge = computeInterpBiasMs(100);
    expect(huge).toBeLessThanOrEqual(200); // reasonable upper bound
  });

  it('Cycle 6: bias decays naturally as drops age out of the window', () => {
    // The slide-out of cycle 5 directly produces the decay — no separate
    // decay logic needed. Verify end-to-end: drops happen, bias is non-
    // zero, time passes, bias returns to zero.
    const d = createDropDetector({ windowSize: 10 });
    observeSnapshotTick(d, 100);
    observeSnapshotTick(d, 109); // 2 drops
    expect(computeInterpBiasMs(d.dropCount)).toBeGreaterThan(20);
    for (let i = 0; i < 10; i++) observeSnapshotTick(d, 109 + (i + 1) * 3);
    expect(computeInterpBiasMs(d.dropCount)).toBe(0);
  });
});
