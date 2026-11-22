/**
 * The left strip never rises over the top-left HUD (owner shots 2026-11-22):
 * the anchor's top is max(HUD bottom + 8px, 57% - half the strip), fed by
 * the two vars leftStripFitVars writes.
 */
import { describe, expect, it } from 'vitest';
import { leftStripFitVars } from './leftStripFit';

/** The anchor's top rule, evaluated in px for a viewport height. */
function stripTop(viewportH: number, hudBottom: number, stripH: number): number {
  return Math.max(hudBottom + 8, 0.57 * viewportH - stripH / 2);
}

describe('leftStripFitVars', () => {
  it('writes both vars as whole px, never negative', () => {
    expect(leftStripFitVars(116.4, 265.6)).toEqual({ '--hud-tl-bottom': '116px', '--left-strip-h': '266px' });
    expect(leftStripFitVars(-3, -1)).toEqual({ '--hud-tl-bottom': '0px', '--left-strip-h': '0px' });
  });

  it('a short strip stays centred at 57%; a tall one sits under the HUD', () => {
    // Pixel 7 sideways: 412 px tall, top-left HUD ends at ~116 px.
    expect(stripTop(412, 116, 120)).toBeCloseTo(0.57 * 412 - 60);
    expect(stripTop(412, 116, 300)).toBe(124);
  });
});
