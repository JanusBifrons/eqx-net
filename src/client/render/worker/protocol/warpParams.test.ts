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

/**
 * #10 — "subtler in-sector warp ripple". The in-sector warp envelope was too
 * loud (a screen-dominating climax + burst + flash). Tone the peaks down and
 * stretch the durations so the same effect reads as a gentler ripple spread over
 * a longer distance (on-device sign-off is a follow-up; this locks the tuning).
 */
describe('warp params — #10 subtler ripple tuning', () => {
  it('drops the climax amplitude to 40', () => {
    expect(DEFAULT_WARP_PARAMS.climaxAmplitude).toBe(40);
  });
  it('drops the burst amplitude to 140', () => {
    expect(DEFAULT_WARP_PARAMS.burstAmplitude).toBe(140);
  });
  it('drops the flash alpha max to 0.35', () => {
    expect(DEFAULT_WARP_PARAMS.flashAlphaMax).toBeCloseTo(0.35, 6);
  });
  it('lengthens the climax + burst durations (~+50%) so the ripple spreads slower', () => {
    // Was climax 1100 / burst 1500; +~50% ⇒ ~1650 / ~2250.
    expect(DEFAULT_WARP_PARAMS.climaxDurationMs).toBeGreaterThanOrEqual(1600);
    expect(DEFAULT_WARP_PARAMS.burstDurationMs).toBeGreaterThanOrEqual(2200);
  });
});
