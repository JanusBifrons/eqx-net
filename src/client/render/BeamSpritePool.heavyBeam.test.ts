/**
 * The capital heavy beam read as a thin orange-red line on film (measured RGB
 * ~(215,117,102) along it): it drew INSIDE the remote pool's container, which
 * `LaserGlow` filters with one orange glow for every remote beam, and that glow
 * swamped its violet core; at capital zoom its 10 u core was also under a px.
 *
 * Locks: a per-beam-styled beam draws in the pool's `styledContainer` (a
 * sibling, never under the glow-filtered `container`), keeps its violet, and is
 * at least `minScreenPx` wide on screen; fighter beams are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { BeamSpritePool, type BeamView } from './BeamSpritePool';
import { HEAVY_BEAM_COLOR, HEAVY_BEAM_MIN_SCREEN_PX, HEAVY_BEAM_STYLE, REMOTE_BEAM_STYLE } from './beamStyles';

const fighter = (y: number): BeamView => ({ fromX: 0, fromY: y, toX: 300, toY: y, style: null });
const heavy = (y: number): BeamView => ({ fromX: 0, fromY: y, toX: 3000, toY: y, style: HEAVY_BEAM_STYLE });

describe('BeamSpritePool — heavy beam lane', () => {
  it('a heavy beam draws violet in styledContainer, outside the glow-filtered container', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    pool.setBeams([fighter(0), heavy(50), fighter(100)], 3, 1);
    const h = pool.coreAt(1)!;
    expect(h.tint).toBe(HEAVY_BEAM_COLOR);
    expect(h.parent).toBe(pool.styledContainer);
    expect(h.parent).not.toBe(pool.container);
    expect(pool.styledContainer.parent).toBeNull(); // the owner adds it as a sibling
    expect(pool.styledContainer.visible).toBe(true);
  });

  it('fighter beams are unchanged: pool style, inside the filtered container', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    pool.setBeams([fighter(0), heavy(50), fighter(100)], 3, 0.03);
    for (const i of [0, 2]) {
      const f = pool.coreAt(i)!;
      expect(f.tint).toBe(REMOTE_BEAM_STYLE.tint);
      expect(f.width).toBe(REMOTE_BEAM_STYLE.width); // no screen floor
      expect(f.parent).toBe(pool.container);
    }
    expect(pool.container.children.filter((c) => c.visible)).toHaveLength(2);
  });

  it('the heavy core is at least HEAVY_BEAM_MIN_SCREEN_PX wide at capital zoom', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    const camScale = 0.03; // a battleship-fight zoom: 10 u = 0.3 px
    pool.setBeams([heavy(0)], 1, camScale);
    expect(pool.coreAt(0)!.width * camScale).toBeCloseTo(HEAVY_BEAM_MIN_SCREEN_PX, 6);
    // Zoomed in, the world width wins (never thinner than 10 u).
    pool.setBeams([heavy(0)], 1, 2);
    expect(pool.coreAt(0)!.width).toBe(HEAVY_BEAM_STYLE.width);
  });

  it('a slot that turns from heavy to fighter moves lanes; the styled lane hides when empty', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    pool.setBeams([heavy(0)], 1, 1);
    pool.setBeams([fighter(0)], 1, 1);
    expect(pool.coreAt(0)!.parent).toBe(pool.container);
    expect(pool.styledContainer.visible).toBe(false);
    expect(pool.styledContainer.children.every((c) => !c.visible)).toBe(true);
    expect(pool.renderedFromX).toBe(0);
    pool.hideAll();
    expect(pool.coreAt(0)).toBeNull();
  });
});
