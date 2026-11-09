/**
 * Convoy budgets (plan soft-leaping-truffle v3, phase T): "TradeNetwork tick
 * ≤ 2 ms; ≤ 6 live convoys per sector". The planning pass is measured over
 * the realistic WORST case (every NPC base in today's galaxy starved of every
 * input, every output piled up); `benchmarks/convoys.bench.ts` reports the
 * same figure as a bench. The live cap is the director's `maxPerSector`.
 *
 * The per-PR gate is a COUNT (plan machine-independent-perf WS3): the
 * candidate exporter checks one pass makes (the planner's inner loop, read
 * through its `allowPair` hook). The "≤ 2 ms" wall-clock assert failed on a
 * hosted runner at 2.07 ms (PR #352) with no code change: host speed, not
 * the planner. The time is still printed here and measured by the bench.
 */
import { describe, expect, it } from 'vitest';
import { matchConvoys } from '../../src/core/economy/convoys.js';
import { hopDistance } from '../../src/server/livingworld/population.js';
import { DEFAULT_CONVOY_OPTIONS } from '../../src/server/economy/ConvoyDirector.js';
import { galaxyConvoyViews } from '../../benchmarks/convoyGalaxyFixture.js';

/** The plan's budget for one planning pass (bench + printout; not asserted). */
const CONVOY_PLAN_MAX_MS = 2;
/** Candidate exporter checks in one worst-case pass: 988 measured 2026-11-08
 *  (deterministic, any host), + 25 %. The 2 ms pass did this much work. */
const CONVOY_PLAN_MAX_CHECKS = 1235;
/** The plan's cap on live convoys in one sector. */
const CONVOYS_PER_SECTOR_MAX = 6;

describe('convoy budgets', () => {
  const views = galaxyConvoyViews();
  const opts = { haulerCapacity: DEFAULT_CONVOY_OPTIONS.haulerCapacity, maxConvoys: DEFAULT_CONVOY_OPTIONS.maxActive, hops: hopDistance };

  it('the worst case really is busy: plans the full convoy allowance', () => {
    expect(views.length).toBeGreaterThan(21); // several sectors hold more than one base
    // A precondition for the timing budget below: the fixture must keep the
    // planner busy. Base growth v7 (NPC bases sized to run their processors
    // flat out, so they no longer brown out) has 2 fewer processors galaxy-wide
    // (89 → 87), and the worst case plans 11 of the 12 allowed.
    expect(matchConvoys(views, opts).length).toBeGreaterThanOrEqual(DEFAULT_CONVOY_OPTIONS.maxActive - 1);
  });

  it(`a planning pass over the whole galaxy makes at most ${CONVOY_PLAN_MAX_CHECKS} candidate checks`, () => {
    let checks = 0;
    matchConvoys(views, { ...opts, allowPair: () => { checks++; return true; } });
    console.log(`[convoy plan] ${views.length} bases: ${checks} candidate checks`);
    expect(checks).toBeLessThanOrEqual(CONVOY_PLAN_MAX_CHECKS);
  });

  it(`prints the pass time against the ${CONVOY_PLAN_MAX_MS} ms design budget (print-only: host speed)`, () => {
    for (let i = 0; i < 5; i++) matchConvoys(views, opts); // warm up
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      matchConvoys(views, opts);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[12]!;
    const best = times[0]!;
    console.log(`[convoy plan] ${views.length} bases: best ${best.toFixed(3)} ms, median ${median.toFixed(3)} ms, max ${times[24]!.toFixed(3)} ms (design budget ${CONVOY_PLAN_MAX_MS} ms${best > CONVOY_PLAN_MAX_MS ? ': OVER on this host' : ''})`);
    expect(best).toBeGreaterThan(0);
  });

  it(`the director keeps at most ${CONVOYS_PER_SECTOR_MAX} live convoys in a sector`, () => {
    expect(DEFAULT_CONVOY_OPTIONS.maxPerSector).toBeLessThanOrEqual(CONVOYS_PER_SECTOR_MAX);
  });
});
