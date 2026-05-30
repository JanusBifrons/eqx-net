/**
 * Heap-delta lock for swarmInterpolation.populated[] migration (plan:
 * quirky-rabbit, Phase 5).
 *
 * Pre-Phase-5 the function allocated a fresh `PoseRingEntry[]` AND
 * called `Array.prototype.sort` per call. At the production cadence
 * (~5-10 in-interest drones × 90 fps on a 90 Hz phone) that's
 * ~450-900 array allocs/sec + sort temps. Post-Phase-5 a module-scope
 * scratch is reused with an insertion sort during fill — zero
 * allocation, no sort-comparator closure.
 *
 * This test exercises the function 100 000 times against a realistic
 * 10-drone fan-out and asserts the heap growth is bounded.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { interpolateSwarmPose, type InterpolatedPose } from './swarmInterpolation.js';
import { POSE_RING_DEPTH, type SwarmRenderState, type PoseRingEntry } from '../../core/contracts/IRenderer.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`.');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

function makeEntry(t0: number): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({
      empty: i >= 3, // first 3 slots populated, rest empty
      x: i * 10,
      y: i * 10,
      vx: 1,
      vy: 1,
      angle: 0.1 * i,
      angvel: 0,
      arrivalMs: t0 + i * 16,
    });
  }
  return {
    x: 0, y: 0, angle: 0, vx: 1, vy: 1, angvel: 0,
    sleeping: false,
    kind: 1,
    radius: 10,
    poseRing: ring,
    ringHead: 3,
  };
}

describe('swarmInterpolation.populated[] heap-delta (Phase 5)', () => {
  it('100 000 calls × 10 drones grows heap by < 200 KB', () => {
    const drones: SwarmRenderState[] = [];
    for (let i = 0; i < 10; i++) drones.push(makeEntry(i * 1000));
    const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };

    // Warmup so JIT settles + the populated-scratch reaches steady state.
    for (let n = 0; n < 1000; n++) {
      for (const d of drones) interpolateSwarmPose(d, n * 16 + 100, out);
    }

    const before = postGcHeap();
    for (let n = 0; n < 10_000; n++) {
      for (const d of drones) interpolateSwarmPose(d, n * 16 + 100, out);
    }
    const after = postGcHeap();

    // 200 KB tolerance — same threshold as the other Phase 5 locks.
    // Pre-pool this loop would have produced 100k × small-array
    // allocs + sort-temps, well past 1 MB of churn.
    expect(after - before).toBeLessThan(200_000);
  });

  it('returns the same InterpolatedPose instance the caller passes', () => {
    const d = makeEntry(0);
    const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const result = interpolateSwarmPose(d, 50, out);
    expect(result).toBe(out); // identity, not just equality
  });
});
