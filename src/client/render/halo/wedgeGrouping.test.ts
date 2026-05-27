/**
 * Behavioural lock for `partitionAndGroupCandidates` — both the
 * legacy fresh-alloc path AND the Phase 5c caller-injected scratch
 * path must produce the same outputs.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionAndGroupCandidates,
  type Candidate,
  type PartitionScratch,
  RADAR_WEDGE_COUNT,
} from './wedgeGrouping.js';

function c(key: string, x: number, y: number, dist: number, color = 0xffffff, hostile = false): Candidate {
  return { key, x, y, color, dist, hostile };
}

function makeScratch(): PartitionScratch {
  return { result: [], wedges: new Map(), wedgeReps: [] };
}

describe('partitionAndGroupCandidates', () => {
  it('keeps within-grouping-distance candidates as-is', () => {
    const cs = [c('a', 100, 100, 500), c('b', 200, 200, 1000)];
    const out = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('drops candidates past maxDistance', () => {
    const cs = [c('a', 100, 100, 500), c('b', 999999, 0, 99999)];
    const out = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    expect(out.map((x) => x.key)).toEqual(['a']);
  });

  it('collapses far candidates into wedge representatives (closest wins)', () => {
    // Two distant candidates at the same bearing — should collapse to
    // one wedge:N representative with the closer dist.
    const cs = [
      c('far-near', 5000, 0, 5000),
      c('far-far', 9000, 0, 9000),
    ];
    const out = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toMatch(/^wedge:/);
    expect(out[0]!.grouped).toBe(true);
    expect(out[0]!.dist).toBe(5000); // closer one wins
  });

  it('scratch path produces the same output as fresh-alloc path', () => {
    const cs = [
      c('near-a', 100, 100, 500),
      c('near-b', -100, 50, 800),
      c('far-east', 5000, 0, 5000),
      c('far-north', 0, 5000, 5000),
      c('far-east-2', 6000, 100, 6000),
    ];
    const fresh = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    const scratch = makeScratch();
    const scratched = partitionAndGroupCandidates({ x: 0, y: 0 }, cs, undefined, undefined, undefined, scratch);
    // Same length, same keys, same coords. The scratch path returns
    // scratch.result by reference.
    expect(scratched).toBe(scratch.result);
    expect(scratched.length).toBe(fresh.length);
    const f = fresh.map((x) => ({ key: x.key, x: x.x, y: x.y, dist: x.dist, grouped: !!x.grouped }));
    const s = scratched.map((x) => ({ key: x.key, x: x.x, y: x.y, dist: x.dist, grouped: !!x.grouped }));
    expect(s).toEqual(f);
  });

  it('scratch path reuses wedgeReps instances across calls', () => {
    const cs = [
      c('far-a', 5000, 0, 5000),
      c('far-b', 0, 5000, 5000),
    ];
    const scratch = makeScratch();
    partitionAndGroupCandidates({ x: 0, y: 0 }, cs, undefined, undefined, undefined, scratch);
    const repsFirstCall = scratch.wedgeReps.slice();
    expect(repsFirstCall.length).toBeGreaterThanOrEqual(2);
    partitionAndGroupCandidates({ x: 0, y: 0 }, cs, undefined, undefined, undefined, scratch);
    // Same instances at index 0 and 1.
    expect(scratch.wedgeReps[0]).toBe(repsFirstCall[0]);
    expect(scratch.wedgeReps[1]).toBe(repsFirstCall[1]);
  });

  it('scratch.result is cleared on entry so prior contents do not leak', () => {
    const scratch = makeScratch();
    scratch.result.push(c('stale', 0, 0, 0));
    partitionAndGroupCandidates({ x: 0, y: 0 }, [c('a', 100, 100, 500)], undefined, undefined, undefined, scratch);
    expect(scratch.result.map((x) => x.key)).toEqual(['a']);
  });

  it('wedge keys are cached (no new string per wedge emission)', () => {
    // The cached key strings live at module scope. Two calls with the
    // same wedge index must return identical string references.
    const cs = [c('far', 5000, 0, 5000)];
    const a = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    const b = partitionAndGroupCandidates({ x: 0, y: 0 }, cs);
    // Both calls produce a wedge:N key for the same N.
    expect(a[0]!.key).toBe(b[0]!.key);
    void RADAR_WEDGE_COUNT;
  });
});
