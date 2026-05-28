/**
 * Heap-delta lock for `partitionAndGroupCandidates` scratch injection
 * (plan: quirky-rabbit, Phase 5c).
 *
 * Pre-fix the function allocated `result: Candidate[]`, `wedges:
 * Map<number, Candidate>`, AND one wedge-representative literal per
 * emitted wedge on every call (radar tick @ 60-90 fps). Post-fix the
 * caller (HaloRadar) injects a class-field scratch; all three are
 * reused across calls, and the `` `wedge:${idx}` `` template literal
 * is now a cached lookup.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionAndGroupCandidates,
  type Candidate,
  type PartitionScratch,
} from './wedgeGrouping.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

function makeScratch(): PartitionScratch {
  return { result: [], wedges: new Map(), wedgeReps: [] };
}

describe('wedgeGrouping scratch heap-delta (Phase 5c)', () => {
  it('100 000 calls × 30 candidates (mixed near + far) grow heap < 200 KB', () => {
    // 10 near-ring candidates kept as-is + 20 far-ring candidates that
    // collapse into ~5-10 wedge representatives. Realistic mid-game
    // radar load.
    const cs: Candidate[] = [];
    for (let i = 0; i < 10; i++) {
      const t = (i / 10) * Math.PI * 2;
      cs.push({ key: `near${i}`, x: Math.cos(t) * 500, y: Math.sin(t) * 500, color: 0xffffff, dist: 500 });
    }
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * Math.PI * 2;
      cs.push({ key: `far${i}`, x: Math.cos(t) * 5000, y: Math.sin(t) * 5000, color: 0xff0000, dist: 5000 });
    }
    const scratch = makeScratch();

    // Warmup so JIT + scratch reach steady state.
    for (let n = 0; n < 1000; n++) {
      partitionAndGroupCandidates({ x: 0, y: 0 }, cs, undefined, undefined, undefined, scratch);
    }

    const before = postGcHeap();
    for (let n = 0; n < 10_000; n++) {
      partitionAndGroupCandidates({ x: 0, y: 0 }, cs, undefined, undefined, undefined, scratch);
    }
    const after = postGcHeap();

    expect(after - before).toBeLessThan(200_000);
  });
});
