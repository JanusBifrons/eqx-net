import { describe, it, expect } from 'vitest';
import { sceneSimTime } from './scenePerfRegistry.js';

describe('sceneSimTime (perf-scene game time vs wall time)', () => {
  it('a scene that kept pace has no lateness', () => {
    expect(sceneSimTime({ ms: 0, tick: 10, dropped: 3 }, { ms: 2000, tick: 130, dropped: 3 }))
      .toEqual({ wallTicks: 120, simTicks: 120, latenessTicks: 0, droppedTicks: 0 });
  });
  it('a starved scene reports the ticks it fell behind and dropped', () => {
    expect(sceneSimTime({ ms: 0, tick: 0, dropped: 0 }, { ms: 1000, tick: 25, dropped: 30 }))
      .toEqual({ wallTicks: 60, simTicks: 25, latenessTicks: 35, droppedTicks: 30 });
  });
});
