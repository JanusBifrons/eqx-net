import { describe, expect, it } from 'vitest';
import { warpFxFeedsShip } from './warpFxGate';

describe('warpFxFeedsShip — drawWarpFx gate (RTS fleet warp S4)', () => {
  it('active ships are always fed', () => {
    expect(warpFxFeedsShip(false, undefined, false)).toBe(true);
  });
  it('a parked hull with a warp phase is fed (spool glow / arrival drop)', () => {
    expect(warpFxFeedsShip(true, 1, false)).toBe(true);
    expect(warpFxFeedsShip(true, 3, false)).toBe(true);
  });
  it('an idle parked hull is fed one frame after its phase clears, then never', () => {
    expect(warpFxFeedsShip(true, undefined, true)).toBe(true);
    expect(warpFxFeedsShip(true, undefined, false)).toBe(false);
  });
});
