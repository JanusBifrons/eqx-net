/**
 * Unit test for the F1 frame-marker analyzer's PURE aggregation
 * (`scripts/analyze-frame-markers.mjs`). The bug class this protects
 * against is silent stats math errors (wrong percentile, residual not
 * subtracting the right means, window filter off-by-one) — the analyzer
 * is the tool that decides F3, so its arithmetic must be locked.
 *
 * The layer here is the pure stats fn (per the F1 spec): we feed
 * synthetic in-memory RoutedEntry rows — no filesystem, no capture dir
 * — and assert mean/p95 + window filtering + the residual identity.
 *
 * Imports the `.mjs` directly: the analyzer is dependency-free Node
 * ESM, runnable standalone; this test lives under `tests/unit/` only
 * because that's where `vitest.config.ts` looks (a `scripts/*.test.ts`
 * would not be collected).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
import {
  stats,
  quantile,
  markerMs,
  gridTotalMs,
  parseNdjson,
  inSpool,
  inBoundary,
  aggregate,
  MARKER_TAGS,
} from '../../scripts/analyze-frame-markers.mjs';

describe('analyze-frame-markers — pure stats', () => {
  it('quantile interpolates linearly on a sorted sample', () => {
    const xs = [0, 10, 20, 30, 40]; // already ascending
    expect(quantile(xs, 0)).toBe(0);
    expect(quantile(xs, 0.5)).toBe(20); // exact middle
    expect(quantile(xs, 1)).toBe(40);
    // pos = (5-1)*0.95 = 3.8 ⇒ 30*(0.2) + 40*(0.8) = 38
    expect(quantile(xs, 0.95)).toBeCloseTo(38, 9);
  });

  it('quantile handles degenerate sizes', () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(quantile([7], 0.95)).toBe(7);
  });

  it('stats computes count/mean/p50/p95/max and drops non-finite', () => {
    const s = stats([1, 2, 3, 4, 100, NaN, Infinity]);
    expect(s.count).toBe(5); // NaN + Infinity dropped
    expect(s.mean).toBeCloseTo((1 + 2 + 3 + 4 + 100) / 5, 9);
    expect(s.p50).toBe(3);
    expect(s.max).toBe(100);
    // p95 of [1,2,3,4,100]: pos=(5-1)*0.95=3.8 ⇒ 4*0.2 + 100*0.8 = 80.8
    expect(s.p95).toBeCloseTo(80.8, 9);
  });

  it('stats on an empty sample is all-NaN with count 0', () => {
    const s = stats([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.p95)).toBe(true);
  });
});

describe('analyze-frame-markers — field extraction', () => {
  it('gridTotalMs sums the three grid sub-fields', () => {
    expect(gridTotalMs({ labelSpecMs: 0.5, textCreateMs: 0.3, cleanupMs: 0.2 })).toBeCloseTo(1.0, 9);
    expect(gridTotalMs({})).toBe(0); // missing ⇒ 0, not NaN
  });

  it('markerMs reads the right field per tag', () => {
    expect(markerMs('renderer_update', { totalMs: 4.2 })).toBe(4.2);
    expect(markerMs('warp_tick', { totalMs: 1.1 })).toBe(1.1);
    expect(markerMs('mirror_rebuild', { totalMs: 2.0 })).toBe(2.0);
    expect(markerMs('mirror_clone', { costMs: 0.7 })).toBe(0.7);
    expect(markerMs('grid_update', { labelSpecMs: 1, textCreateMs: 1, cleanupMs: 1 })).toBe(3);
    expect(Number.isNaN(markerMs('renderer_update', { nope: 1 }))).toBe(true);
    expect(Number.isNaN(markerMs('unknown_tag', {}))).toBe(true);
  });

  it('MARKER_TAGS is the documented set of 5', () => {
    expect([...MARKER_TAGS].sort()).toEqual(
      ['grid_update', 'mirror_clone', 'mirror_rebuild', 'renderer_update', 'warp_tick'].sort(),
    );
  });
});

describe('analyze-frame-markers — ndjson + window predicates', () => {
  it('parseNdjson tolerates blank + truncated trailing lines', () => {
    const text =
      '{"source":"client","ts":1,"tag":"warp_tick","data":{"totalMs":2}}\n' +
      '\n' +
      '   \n' +
      '{"source":"client","ts":2,"tag":"rafTick","data":{"elapsedMs":17}}\n' +
      '{"source":"client","ts":3,"tag":"warp_tic'; // truncated, no newline
    const rows = parseNdjson(text);
    expect(rows).toHaveLength(2);
    expect(rows[0].tag).toBe('warp_tick');
    expect(rows[1].tag).toBe('rafTick');
  });

  it('inSpool is inclusive on both ends', () => {
    const spool = { start: 100, end: 200 };
    expect(inSpool(100, spool)).toBe(true);
    expect(inSpool(200, spool)).toBe(true);
    expect(inSpool(99.999, spool)).toBe(false);
    expect(inSpool(200.001, spool)).toBe(false);
  });

  it('inBoundary matches within half-width of any boundary ts', () => {
    const bs = [1000, 5000];
    expect(inBoundary(1000, bs, 150)).toBe(true);
    expect(inBoundary(1150, bs, 150)).toBe(true);
    expect(inBoundary(1151, bs, 150)).toBe(false);
    expect(inBoundary(4850, bs, 150)).toBe(true); // near the 5000 boundary
    expect(inBoundary(3000, bs, 150)).toBe(false); // between, not near either
  });
});

describe('analyze-frame-markers — aggregate + residual identity', () => {
  it('partitions rows into spool vs boundary windows and computes residual', () => {
    // Spool window ts 100..200; one boundary at ts 1000 (±150).
    const spool = { start: 100, end: 200 };
    const boundaryTs = [1000];

    const entries = [
      // --- spool-window rows ---
      { source: 'client', ts: 110, tag: 'renderer_update', data: { totalMs: 4, spriteCount: 9 } },
      { source: 'client', ts: 150, tag: 'renderer_update', data: { totalMs: 6, spriteCount: 9 } },
      { source: 'client', ts: 120, tag: 'warp_tick', data: { totalMs: 1, filterCount: 4 } },
      { source: 'client', ts: 160, tag: 'warp_tick', data: { totalMs: 3, filterCount: 4 } },
      { source: 'client', ts: 130, tag: 'grid_update', data: { labelSpecMs: 0.5, textCreateMs: 0.3, cleanupMs: 0.2 } },
      { source: 'client', ts: 170, tag: 'mirror_rebuild', data: { totalMs: 2 } },
      { source: 'client', ts: 180, tag: 'mirror_clone', data: { costMs: 1, approxBytes: 4096 } },
      // frame elapsedMs (rafTick) inside spool: mean = (16 + 20)/2 = 18
      { source: 'client', ts: 115, tag: 'rafTick', data: { elapsedMs: 16 } },
      { source: 'client', ts: 165, tag: 'rafTick', data: { elapsedMs: 20 } },

      // --- boundary-window rows (near ts 1000) ---
      { source: 'client', ts: 1000, tag: 'renderer_update', data: { totalMs: 30 } },
      { source: 'client', ts: 1010, tag: 'raf_gap', data: { elapsedMs: 120 } },

      // --- outside both windows: must be ignored entirely ---
      { source: 'client', ts: 500, tag: 'renderer_update', data: { totalMs: 999 } },
      { source: 'client', ts: 500, tag: 'rafTick', data: { elapsedMs: 999 } },
    ];

    const r = aggregate(entries, { spool, boundaryTs, boundaryHalfWidth: 150 });

    // Spool marker means.
    expect(r.spool.markers.renderer_update.mean).toBeCloseTo(5, 9); // (4+6)/2
    expect(r.spool.markers.renderer_update.count).toBe(2);
    expect(r.spool.markers.warp_tick.mean).toBeCloseTo(2, 9); // (1+3)/2
    expect(r.spool.markers.grid_update.mean).toBeCloseTo(1.0, 9); // 0.5+0.3+0.2
    expect(r.spool.markers.mirror_rebuild.mean).toBeCloseTo(2, 9);
    expect(r.spool.markers.mirror_clone.mean).toBeCloseTo(1, 9);

    // Σ(means) = 5 + 2 + 1 + 2 + 1 = 11; frame mean = 18 ⇒ residual 7.
    expect(r.spool.sumMarkerMeans).toBeCloseTo(11, 9);
    expect(r.spool.frame.mean).toBeCloseTo(18, 9);
    expect(r.spool.residualMs).toBeCloseTo(7, 9);

    // The ts=500 outliers were excluded (else means would explode).
    expect(r.spool.markers.renderer_update.max).toBe(6);

    // Boundary window: only the two near-1000 rows.
    expect(r.boundary.markers.renderer_update.mean).toBeCloseTo(30, 9);
    expect(r.boundary.frame.mean).toBeCloseTo(120, 9);
    // residual = 120 − 30 = 90 (other markers absent ⇒ mean NaN ⇒ not summed).
    expect(r.boundary.sumMarkerMeans).toBeCloseTo(30, 9);
    expect(r.boundary.residualMs).toBeCloseTo(90, 9);
  });

  it('residual is NaN when a window has no frame samples (cannot attribute)', () => {
    const r = aggregate(
      [{ source: 'client', ts: 150, tag: 'warp_tick', data: { totalMs: 5 } }],
      { spool: { start: 100, end: 200 }, boundaryTs: [] },
    );
    expect(r.spool.markers.warp_tick.mean).toBeCloseTo(5, 9);
    expect(Number.isNaN(r.spool.frame.mean)).toBe(true);
    expect(Number.isNaN(r.spool.residualMs)).toBe(true);
  });
});
