/**
 * Regression lock: the "full-screen one-pixel hairlines" in the capital
 * showcase clips (hostile reviews 2026-11-12: ct4-review turrets.png /
 * line.png / s92.png, cby-review grid.png, clip capital-turrets).
 *
 * Reviewers saw faint, bluish, axis-aligned lines spanning the whole
 * screen that sat at a new position on most frames and flickered on and
 * off. Frame analysis of the capital-turrets clip showed a regular
 * lattice (micro lines every ~60 px, every 5th one brighter = the
 * 500 u / 2500 u BackgroundGrid at camera scale ~0.12) that drew on some
 * frames and vanished on others.
 *
 * Cause: the grid stroked `width: 1` in WORLD units. At a capital zoom
 * (scale 0.01-0.15) that is a 0.01-0.15 px wide quad; the GPU only
 * lights a pixel whose centre the quad covers, so each line popped in as
 * a hard 1 px line on some frames and dropped out on others as the
 * camera moved sub-pixel. And at the battleship floor (~0.0127) the
 * 500 u tier sits ~6 px apart, a near-solid hatch whenever it does draw.
 *
 * Fix locked here: every grid stroke is a `pixelLine` (one device pixel
 * at any zoom, never sub-pixel), and a tier whose lines sit too close on
 * screen fades out instead of hatching the view.
 */
import { describe, it, expect, vi } from 'vitest';
import { BackgroundGrid, gridTierAlpha } from './BackgroundGrid.js';

vi.mock('pixi.js', () => {
  class FakeGraphics {
    alpha = 1;
    visible = true;
    clear = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  return { Graphics: FakeGraphics };
});

interface FakeGfx {
  alpha: number;
  visible: boolean;
  clear: { mock: { calls: unknown[] } };
  moveTo: { mock: { calls: unknown[] } };
  stroke: { mock: { calls: Array<[{ width?: number; pixelLine?: boolean }]> } };
}

function camera(scale: number, cx = 0, cy = 0) {
  return {
    center: { x: cx, y: cy },
    worldScreenWidth: 1280 / scale,
    worldScreenHeight: 720 / scale,
    scale: { x: scale, y: scale },
    addChild: vi.fn(),
  };
}

function tiers(g: BackgroundGrid): { micro: FakeGfx; macro: FakeGfx } {
  const any = g as unknown as { microLines: FakeGfx; macroLines: FakeGfx };
  return { micro: any.microLines, macro: any.macroLines };
}

// Camera scales seen in the capital clips plus the legacy range.
const CAPITAL_SCALES = [0.0046, 0.0085, 0.0127, 0.05, 0.12, 0.15, 0.4, 1, 3];

describe('BackgroundGrid — no sub-pixel hairlines', () => {
  it.each(CAPITAL_SCALES)('every stroke is a one-pixel pixelLine at scale %s', (scale) => {
    const g = new BackgroundGrid();
    const cam = camera(scale, 1234, -5678);
    g.attach(cam as never);
    g.update(cam as never);
    const { micro, macro } = tiers(g);
    for (const t of [micro, macro]) {
      for (const [style] of t.stroke.mock.calls) {
        // A world-unit width times a capital zoom is a fraction of a pixel:
        // the line rasterises on some frames and not others (the flicker).
        expect(style.pixelLine).toBe(true);
      }
    }
    expect(micro.stroke.mock.calls.length + macro.stroke.mock.calls.length).toBeGreaterThan(0);
  });

  it('a tier whose lines are under 8 px apart on screen is hidden, not drawn as a hatch', () => {
    // Battleship floor at 1920x1080: 500 u = 6.35 px apart.
    const g = new BackgroundGrid();
    const cam = camera(0.0127);
    g.attach(cam as never);
    g.update(cam as never);
    const { micro, macro } = tiers(g);
    expect(micro.visible).toBe(false);
    expect(micro.moveTo.mock.calls.length).toBe(0);
    // 2500 u = 32 px apart: still a readable lattice.
    expect(macro.visible).toBe(true);
    expect(macro.alpha).toBeGreaterThan(0.99);
  });

  it('the hidden tier rebuilds when it zooms back into view', () => {
    const g = new BackgroundGrid();
    const cam = camera(0.0127);
    g.attach(cam as never);
    g.update(cam as never);
    const zoomed = camera(0.12);
    g.update(zoomed as never);
    const { micro } = tiers(g);
    expect(micro.visible).toBe(true);
    expect(micro.moveTo.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('gridTierAlpha', () => {
  it('is 0 below 8 px spacing, 1 from 24 px, and rises monotonically between', () => {
    expect(gridTierAlpha(500, 0.0127)).toBe(0);
    expect(gridTierAlpha(500, 0.12)).toBe(1);
    let prev = -1;
    for (let px = 0; px <= 40; px += 0.5) {
      const a = gridTierAlpha(px, 1);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      prev = a;
    }
  });

  it('never returns NaN for a degenerate scale', () => {
    expect(gridTierAlpha(500, 0)).toBe(0);
    expect(gridTierAlpha(500, Number.NaN)).toBe(0);
  });
});
