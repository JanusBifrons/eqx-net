import { describe, it, expect } from 'vitest';
import { createLaneDelayWindow, sampleLaneDelay, takeLaneDelayWindow, type LaneDelayReadings } from './laneDelayWindow.js';

function readings(over: Partial<LaneDelayReadings> = {}): LaneDelayReadings {
  return {
    delayMs: 120.04, targetMs: 110.06, steadyMs: 112.34,
    holdFrames: 0, resyncs: 0, glideLimits: 0, oldEndClamps: 0, swarmPackets: 0,
    missileDelayMs: 118.25, missileHoldFrames: 0, missileResyncs: 0, ...over,
  };
}

describe('phone-lane display-delay window', () => {
  it('reports min / mean / max of the per-frame drone delay, plus current, target and steady', () => {
    const w = createLaneDelayWindow();
    for (const d of [100, 140, 120, Number.NaN, 160]) sampleLaneDelay(w, d);
    const s = takeLaneDelayWindow(w, readings());
    expect(s).toMatchObject({
      droneDelayMs: 120, droneDelayMinMs: 100, droneDelayMeanMs: 130, droneDelayMaxMs: 160,
      droneDelayTargetMs: 110.1, droneSteadyDelayMs: 112.3, missileDelayMs: 118.3,
    });
  });

  it('counts each counter since the previous window and resets the samples', () => {
    const w = createLaneDelayWindow();
    takeLaneDelayWindow(w, readings({ holdFrames: 10, resyncs: 1, glideLimits: 50, oldEndClamps: 2, swarmPackets: 300, missileHoldFrames: 4, missileResyncs: 1 }));
    sampleLaneDelay(w, 200);
    const s = takeLaneDelayWindow(w, readings({ holdFrames: 25, resyncs: 2, glideLimits: 80, oldEndClamps: 2, swarmPackets: 500, missileHoldFrames: 9, missileResyncs: 1 }));
    expect(s).toMatchObject({
      droneHoldFrames: 15, droneResyncs: 1, droneGlideLimits: 30, droneOldEndClamps: 0,
      swarmPackets: 200, missileHoldFrames: 5, missileResyncs: 0, droneDelayMinMs: 200, droneDelayMaxMs: 200,
    });
    // Next window: no frames sampled, nothing new counted.
    const next = takeLaneDelayWindow(w, readings({ holdFrames: 25, resyncs: 2, glideLimits: 80, oldEndClamps: 2, swarmPackets: 500, missileHoldFrames: 9, missileResyncs: 1 }));
    expect(next).toMatchObject({ droneDelayMinMs: null, droneDelayMeanMs: null, droneDelayMaxMs: null, droneHoldFrames: 0, swarmPackets: 0 });
  });

  it('a counter that went backwards (sector change reset) counts from zero', () => {
    const w = createLaneDelayWindow();
    takeLaneDelayWindow(w, readings({ swarmPackets: 900, holdFrames: 40 }));
    const s = takeLaneDelayWindow(w, readings({ swarmPackets: 120, holdFrames: 3 }));
    expect(s).toMatchObject({ swarmPackets: 120, droneHoldFrames: 3 });
  });

  it('missile delay is null before its stream seeds; every field is a number or null', () => {
    const s = takeLaneDelayWindow(createLaneDelayWindow(), readings({ missileDelayMs: Number.NaN }));
    expect(s.missileDelayMs).toBeNull();
    for (const v of Object.values(s)) expect(v === null || typeof v === 'number').toBe(true);
  });
});
