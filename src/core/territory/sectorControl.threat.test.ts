import { describe, expect, it } from 'vitest';
import { THREAT_LOW_SHARE, controlThreat } from './sectorControl.js';

describe('controlThreat — the holder is threatened when its share falls OR its structures were hit', () => {
  it('neutral ground is never threatened', () => {
    expect(controlThreat(false, -1, 0, true, true)).toBe(0);
  });

  it('a steady holder with no hits is calm, even with fighting in the sector', () => {
    expect(controlThreat(true, 0, 100, false, true)).toBe(0);
    expect(controlThreat(true, 1, 20, false, true)).toBe(0);
  });

  it('one sign = 1; both signs = 2', () => {
    expect(controlThreat(true, -1, 90, false, false)).toBe(1);
    expect(controlThreat(true, 0, 90, true, false)).toBe(1);
    expect(controlThreat(true, -1, 90, true, false)).toBe(2);
  });

  it('recent combat or a low share adds 1 to a threatened holder', () => {
    expect(controlThreat(true, -1, 90, false, true)).toBe(2);
    expect(controlThreat(true, -1, THREAT_LOW_SHARE, false, false)).toBe(2);
    expect(controlThreat(true, -1, THREAT_LOW_SHARE + 1, false, false)).toBe(1);
    expect(controlThreat(true, -1, 30, true, true)).toBe(3);
    expect(controlThreat(true, -1, 90, true, true)).toBe(3);
  });
});
