import { describe, expect, it } from 'vitest';
import { captureCrop, cropFilter } from './captureCrop.js';

const PAGE = { width: 844, height: 390 };
const CAP = { maxWidth: 1688, maxHeight: 780 };

describe('captureCrop', () => {
  it('leaves a frame alone when Chrome captures the page at its own size', () => {
    expect(captureCrop({ deviceWidth: 844, deviceHeight: 390 }, PAGE, CAP)).toBeNull();
  });

  it('crops to the page when the capture surface is twice the page (alien-gate take, 2026-11-26)', () => {
    // Chrome reported 1688×780 while the page was 844×390: the game painted
    // into the top-left quarter and the rest of the frame was black.
    expect(captureCrop({ deviceWidth: 1688, deviceHeight: 780 }, PAGE, CAP)).toEqual({ w: 844, h: 390 });
  });

  it('scales the crop when the screencast cap shrank the frame', () => {
    expect(captureCrop({ deviceWidth: 3376, deviceHeight: 1560 }, PAGE, CAP)).toEqual({ w: 422, h: 195 });
  });

  it('builds the ffmpeg crop step only when there is a crop', () => {
    expect(cropFilter(undefined)).toBe('');
    expect(cropFilter({ w: 844, h: 390 })).toBe('crop=844:390:0:0,');
  });
});
