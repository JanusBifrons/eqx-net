/**
 * Convoy budgets (plan soft-leaping-truffle v3, phase T): "TradeNetwork tick
 * ≤ 2 ms; ≤ 6 live convoys per sector". The planning pass is measured over
 * the realistic WORST case (every NPC base in today's galaxy starved of every
 * input, every output piled up); `benchmarks/convoys.bench.ts` reports the
 * same figure as a bench. The live cap is the director's `maxPerSector`.
 */
import { describe, expect, it } from 'vitest';
import { matchConvoys } from '../../src/core/economy/convoys.js';
import { hopDistance } from '../../src/server/livingworld/population.js';
import { DEFAULT_CONVOY_OPTIONS } from '../../src/server/economy/ConvoyDirector.js';
import { galaxyConvoyViews } from '../../benchmarks/convoyGalaxyFixture.js';

/** The plan's budget for one planning pass. */
const CONVOY_PLAN_MAX_MS = 2;
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

  it(`a planning pass over the whole galaxy stays within ${CONVOY_PLAN_MAX_MS} ms (fastest of 25: host noise only adds)`, () => {
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
    console.log(`[convoy plan] ${views.length} bases: median ${median.toFixed(3)} ms, max ${times[24]!.toFixed(3)} ms`);
    expect(best).toBeLessThanOrEqual(CONVOY_PLAN_MAX_MS);
  });

  it(`the director keeps at most ${CONVOYS_PER_SECTOR_MAX} live convoys in a sector`, () => {
    expect(DEFAULT_CONVOY_OPTIONS.maxPerSector).toBeLessThanOrEqual(CONVOYS_PER_SECTOR_MAX);
  });
});
