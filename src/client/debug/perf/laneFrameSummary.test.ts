import { describe, it, expect } from 'vitest';
import { FrameTimeRing } from '@core/perf/FrameTimeRing';
import { buildLanePerfSummary, LANE_HITCH_MS, type LaneSummaryInputs } from './laneFrameSummary';

const NET = { rttMs: 80, rttMeanMs: 75.4321, snapshotJitterMs: 12.345, significantCorrectionCount: 40, rollingCorrRate: 0.3, maxDriftUnits: 4.56789 };

function inputs(over: Partial<LaneSummaryInputs> = {}): LaneSummaryInputs {
  return {
    windowMs: 10_000, viewHalf: 1834.567, counts: { ships: 3, drones: 120, structures: 45, projectiles: 7 },
    net: NET, correctionsBefore: 25, ...over,
  };
}

describe('phone-lane perf summary', () => {
  it('reports frame-time percentiles, >50 ms hitches and the longest frame', () => {
    const ring = new FrameTimeRing(2048);
    for (let i = 0; i < 97; i++) ring.push(11);
    ring.push(45); // a stutter, under the 50 ms hitch line
    ring.push(60);
    ring.push(140);
    const s = buildLanePerfSummary(ring, inputs());
    expect(LANE_HITCH_MS).toBe(50);
    expect(s).toMatchObject({ frames: 100, p50: 11, p95: 11, p99: 140, maxMs: 140, hitches: 2 });
  });

  it('carries zoom, entity counts, RTT and the corrections made in this window', () => {
    const ring = new FrameTimeRing(64);
    ring.push(16);
    const s = buildLanePerfSummary(ring, inputs());
    expect(s).toMatchObject({
      windowMs: 10_000, viewHalf: 1835, ships: 3, drones: 120, structures: 45, projectiles: 7,
      rttMs: 80, rttMeanMs: 75.4, jitterMs: 12.3, corrections: 15, corrRate: 0.3, maxDrift: 4.57,
    });
  });

  it('a counter that went backwards (new room / client) counts from zero', () => {
    const s = buildLanePerfSummary(new FrameTimeRing(8), inputs({ correctionsBefore: 90 }));
    expect(s.corrections).toBe(40);
  });

  it('no client yet: frame numbers only, the rest null; nothing identifying', () => {
    const s = buildLanePerfSummary(new FrameTimeRing(8), inputs({ viewHalf: null, counts: null, net: null }));
    expect(s).toMatchObject({ frames: 0, maxMs: 0, hitches: 0, viewHalf: null, ships: null, rttMs: null, corrections: null });
    // Numbers and nulls only: no ids, names, user agent or position.
    for (const v of Object.values(s)) expect(v === null || typeof v === 'number').toBe(true);
  });
});
