/**
 * Locks the graceful bulk-gap-recovery decisions (diag `xxiyix`,
 * 2026-05-17). The end pose is never changed by these — only the visual
 * approach is spread so a network-bunched delivery gap reads as a brief
 * smooth catch-up instead of a synchronized N-entity teleport.
 *
 * Steady-state invariant (the load-bearing one): for normal small
 * corrections and on-cadence snapshots, these MUST return the pre-fix
 * behaviour so chapter-2 lockstep + the feel-test-lockstep canary are
 * untouched. Only the pathological gap-recovery path changes.
 */
import { describe, it, expect } from 'vitest';
import { playerCorrectionHalfLifeMs } from './correctionSmoothing.js';

describe('playerCorrectionHalfLifeMs', () => {
  it('keeps pre-fix snappy behaviour for steady-state corrections (canary-safe)', () => {
    // Pre-fix curve: <0.5 → 12, everything else → 25. These small drifts
    // are the steady-state combat case the feel-test-lockstep canary
    // measures — they MUST be byte-identical.
    expect(playerCorrectionHalfLifeMs(0)).toBe(12);
    expect(playerCorrectionHalfLifeMs(0.49)).toBe(12);
    expect(playerCorrectionHalfLifeMs(0.5)).toBe(25);
    expect(playerCorrectionHalfLifeMs(5)).toBe(25);
    expect(playerCorrectionHalfLifeMs(20)).toBe(25); // top of the snappy band
  });

  it('glides large gap-recovery corrections instead of snapping them', () => {
    // The captured gap corrections (178, 249 u) must settle far gentler
    // than the 25 ms that made them ~5-frame teleports.
    expect(playerCorrectionHalfLifeMs(178)).toBeGreaterThan(120);
    expect(playerCorrectionHalfLifeMs(249)).toBeGreaterThanOrEqual(200);
    // Bounded — a glide, not a crawl.
    expect(playerCorrectionHalfLifeMs(1e6)).toBeLessThanOrEqual(250);
  });

  it('is monotonic non-decreasing in drift (no discontinuous snap-back)', () => {
    let prev = -1;
    for (let d = 0; d <= 400; d += 0.5) {
      const h = playerCorrectionHalfLifeMs(d);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
});
