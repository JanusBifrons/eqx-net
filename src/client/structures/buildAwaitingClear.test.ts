import { describe, it, expect } from 'vitest';
import { buildStalledLine, isBuildAwaitingClear } from './buildAwaitingClear.js';

describe('isBuildAwaitingClear', () => {
  it('is true only for a finished build that is still a blueprint', () => {
    expect(isBuildAwaitingClear({ built: false, buildPct: 1 })).toBe(true);
    expect(isBuildAwaitingClear({ built: false, buildPct: 0.99 })).toBe(false);
    expect(isBuildAwaitingClear({ built: true, buildPct: 1 })).toBe(false);
  });

  it('is false while the structure is being taken down', () => {
    expect(isBuildAwaitingClear({ built: false, buildPct: 1, isDeconstructing: true })).toBe(false);
  });
});


describe('buildStalledLine', () => {
  it('names why a paused build is paused', () => {
    expect(buildStalledLine({ buildNotConnected: true })).toBe('PAUSED — NOT CONNECTED TO A CAPITAL');
    expect(buildStalledLine({ buildMineralsShort: 1200 })).toBe('PAUSED — NEEDS 1,200 MORE MINERALS');
  });

  it('is undefined when there is no known reason', () => {
    expect(buildStalledLine({})).toBeUndefined();
  });
});
