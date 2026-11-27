/**
 * The left strip never rises over the top-left HUD and never runs off the
 * bottom (owner shots 2026-11-22): the anchor's top is
 * max(HUD bottom + 8px, 57% - half the strip), and a strip taller than the room
 * under the HUD scales down to fit, fed by the vars leftStripFitVars writes.
 */
import { describe, expect, it } from 'vitest';
import { MIN_STRIP_SCALE, leftColumnFit, leftStripFitVars } from './leftStripFit';
import { ANCHOR_STYLES } from './anchors';

/** The anchor's top rule, evaluated in px for a viewport height. */
function stripTop(viewportH: number, hudBottom: number, stripH: number): number {
  return Math.max(hudBottom + 8, 0.57 * viewportH - stripH / 2);
}

const px = (v: string | undefined): number => parseFloat(v ?? 'NaN');

describe('leftStripFitVars', () => {
  it('writes whole px, never negative; a strip that fits is not scaled', () => {
    expect(leftStripFitVars(116.4, 265.6, 900)).toEqual({
      '--hud-tl-bottom': '116px', '--left-strip-h': '266px', '--left-strip-scale': '1', '--left-strip-w': '0px',
    });
    expect(leftStripFitVars(-3, -1, 900)).toEqual({
      '--hud-tl-bottom': '0px', '--left-strip-h': '0px', '--left-strip-scale': '1', '--left-strip-w': '0px',
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

  it('publishes the strip width (scaled, plus the gap) so the spool bar sits beside it', () => {
    expect(leftStripFitVars(116, 200, 900, 52)['--left-strip-w']).toBe('60px');
    // Scaled strip: 360 px tall in 280 px of room → 0.778 × 52 ≈ 40, + 8.
    expect(leftStripFitVars(116, 360, 412, 52)['--left-strip-w']).toBe('48px');
  });

  it('never shrinks below the floor', () => {
    expect(px(leftStripFitVars(116, 2000, 412)['--left-strip-scale'])).toBe(MIN_STRIP_SCALE);
  });
});

describe('the who-hex column (left-column anchor)', () => {
  it('starts 8px under the whole top-left HUD, in line with it', () => {
    expect(ANCHOR_STYLES['left-column'].top).toBe('calc(var(--hud-tl-bottom, 0px) + 8px)');
    expect(ANCHOR_STYLES['left-column'].left).toBe(ANCHOR_STYLES['top-left'].left);
    expect(ANCHOR_STYLES['left-column'].transformOrigin).toBe('top left');
  });

  it('five hexes (240 px) fit unscaled at 863×360 under the chip + mode switch', () => {
    // HUD ends ~73 px: top 81, bottom 321, inside 360 - 8.
    expect(leftColumnFit(73, 240, 360, 16, 78)).toEqual({ vars: { '--left-column-scale': '1' }, reach: 102 });
  });

  it('with the cargo chip too (HUD ~116 px) the column scales to keep its bottom on screen', () => {
    const { vars } = leftColumnFit(116, 240, 360, 16, 78);
    const scale = px(vars['--left-column-scale']);
    expect(scale).toBeLessThan(1);
    expect(116 + 8 + 240 * scale).toBeLessThanOrEqual(360 - 8 + 0.5);
  });

  it('an empty column reaches nothing (the spool bar keeps its place)', () => {
    expect(leftColumnFit(73, 0, 360, 16, 0).reach).toBe(0);
  });
});
