import { describe, it, expect } from 'vitest';
import { DEFAULT_WARP_PARAMS } from './warpParams';

/**
 * WS-14 / R2.9 — "remove warp glow". The screen-wide BloomFilter glow was
 * removed from the warp filter chain; this locks that the bloom param stays
 * gone (a regression that re-adds the BloomFilter would have to re-add this
 * param) while the single subtle white ARRIVAL FLASH reveal stays.
 *
 * The flash-still-fires behaviour is locked separately by
 * `PixiRenderer.warpBurst.test.ts` (warpEventFiresBurst('warp-in') === true).
 */
describe('warp params — R2.9 glow removed, flash kept', () => {
  it('carries no bloom param (the glow is gone)', () => {
    expect('bloomStrengthMax' in DEFAULT_WARP_PARAMS).toBe(false);
  });

  it('keeps the white arrival-flash reveal params', () => {
    expect(DEFAULT_WARP_PARAMS.flashAlphaMax).toBeGreaterThan(0);
    expect(DEFAULT_WARP_PARAMS.flashDurationMs).toBeGreaterThan(0);
  });
});
