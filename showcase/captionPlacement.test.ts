import { describe, it, expect } from 'vitest';
import { CAPTION_DEFAULT_BOTTOM, CAPTION_HUD_MARGIN, captionBottomPx, hudTopInFrame } from './captionPlacement';

const H = 1080;

/** Review 2026-11-12: in spectator takes the lower-third caption sat on the
 *  42-slot build bar; the caption must sit above the game's bottom HUD. */
describe('caption placement above the bottom HUD', () => {
  it('with no bottom HUD (pilot mode) the caption stays in its default place', () => {
    expect(captionBottomPx(null)).toBe(CAPTION_DEFAULT_BOTTOM);
  });

  it("the caption's box ends above the build bar's top edge, with a margin", () => {
    for (const hudTop of [900, 820, 700, 1000]) {
      const boxBottomY = H - captionBottomPx(hudTop);
      expect(boxBottomY).toBeLessThanOrEqual(hudTop - CAPTION_HUD_MARGIN);
    }
  });

  it('a HUD lower than the default caption never pushes the caption down', () => {
    expect(captionBottomPx(1070)).toBe(CAPTION_DEFAULT_BOTTOM);
  });

  it('maps the bar top from a 720p capture into the 1080p frame', () => {
    expect(hudTopInFrame(600, { width: 1280, height: 720 })).toBeCloseTo(900);
  });

  it('accounts for letterbox padding when the capture is not 16:9', () => {
    // 1280×800 scales by min(1.5, 1.35) = 1.35: pillarboxed, no vertical pad.
    expect(hudTopInFrame(400, { width: 1280, height: 800 })).toBeCloseTo(540);
    // 1600×800 scales by 1.2 → 960 high, 60 px pad top.
    expect(hudTopInFrame(800, { width: 1600, height: 800 })).toBeCloseTo(1020);
  });

  it('a 720p spectator take (bar top at 600 CSS px) clears the bar in the frame', () => {
    const top = hudTopInFrame(600, { width: 1280, height: 720 });
    expect(H - captionBottomPx(top)).toBeLessThanOrEqual(900 - CAPTION_HUD_MARGIN);
  });
});
