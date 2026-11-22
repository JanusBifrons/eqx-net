/**
 * The left strip never rises over the top-left HUD and never runs off the
 * bottom (owner shots 2026-11-22): the anchor's top is
 * max(HUD bottom + 8px, 57% - half the strip), and a strip taller than the room
 * under the HUD scales down to fit, fed by the vars leftStripFitVars writes.
 */
import { describe, expect, it } from 'vitest';
import { MIN_STRIP_SCALE, leftStripFitVars } from './leftStripFit';

/** The anchor's top rule, evaluated in px for a viewport height. */
function stripTop(viewportH: number, hudBottom: number, stripH: number): number {
  return Math.max(hudBottom + 8, 0.57 * viewportH - stripH / 2);
}

const px = (v: string | undefined): number => parseFloat(v ?? 'NaN');

describe('leftStripFitVars', () => {
  it('writes whole px, never negative; a strip that fits is not scaled', () => {
    expect(leftStripFitVars(116.4, 265.6, 900)).toEqual({
      '--hud-tl-bottom': '116px', '--left-strip-h': '266px', '--left-strip-scale': '1',
    });
    expect(leftStripFitVars(-3, -1, 900)).toEqual({
      '--hud-tl-bottom': '0px', '--left-strip-h': '0px', '--left-strip-scale': '1',
    });
  });

  it('a short strip stays centred at 57%; a tall one sits under the HUD', () => {
    // Pixel 7 sideways: 412 px tall, top-left HUD ends at ~116 px.
    expect(stripTop(412, 116, 120)).toBeCloseTo(0.57 * 412 - 60);
    expect(stripTop(412, 116, 280)).toBe(124);
  });

  it('an 8-icon strip on a sideways phone shrinks so its bottom stays on screen', () => {
    // 8 tiles + separator + padding ≈ 360 px natural; room under the HUD is 412 - 116 - 16 = 280.
    const v = leftStripFitVars(116, 360, 412);
    const scale = px(v['--left-strip-scale']);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThanOrEqual(MIN_STRIP_SCALE);
    const h = px(v['--left-strip-h']);
    expect(stripTop(412, 116, h) + h).toBeLessThanOrEqual(412 - 8 + 0.5);
  });

  it('never shrinks below the floor', () => {
    expect(px(leftStripFitVars(116, 2000, 412)['--left-strip-scale'])).toBe(MIN_STRIP_SCALE);
  });
});
