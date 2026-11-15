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
import { Texture, TextureSource } from 'pixi.js';
import { BeamSpritePool, crossSectionTextures, type BeamView } from './BeamSpritePool';
import { crossSectionAt, crossSectionPixels, CROSS_SECTION_ROWS } from './beamCrossSection';
import {
  HEAVY_BEAM_COLOR, HEAVY_BEAM_CROSS_SECTION, HEAVY_BEAM_DEEP_COLOR, HEAVY_BEAM_MIN_SCREEN_PX, HEAVY_BEAM_STYLE, REMOTE_BEAM_STYLE, remoteBeamSolidLen,
} from './beamStyles';

const fighter = (y: number): BeamView => ({ fromX: 0, fromY: y, toX: 300, toY: y, style: null });
const heavy = (y: number): BeamView => ({ fromX: 0, fromY: y, toX: 3000, toY: y, style: HEAVY_BEAM_STYLE });

describe('BeamSpritePool — heavy beam lane', () => {
  it('a heavy beam draws its violet cross-section in styledContainer, outside the glow-filtered container', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    pool.setBeams([fighter(0), heavy(50), fighter(100)], 3, 1);
    const h = pool.coreAt(1)!;
    // Its colours are in its own texture (drawn untinted), not a tinted flat bar.
    expect(h.texture).toBe(crossSectionTextures(HEAVY_BEAM_CROSS_SECTION).solid);
    expect(h.tint).toBe(0xffffff);
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

/**
 * Filmed review 2026-11-15: the heavy beam tapered to ~3–5 px and dimmed over
 * its last third, right where it met the target (it drew on the pool's taper
 * gradient, opaque only for the first 55 %). A heavy capital beam stays full
 * width and bright to its hit point; fighter beams keep their taper.
 */
describe('BeamSpritePool — the heavy beam reaches its hit at full strength', () => {
  /** A pool whose taper gradient is a real 256-px texture (headless falls
   *  back to the 1×1 WHITE, which would hide which texture a beam drew on). */
  function poolWithRealGradient(): { pool: BeamSpritePool; gradient: Texture } {
    const gradient = new Texture({ source: new TextureSource({ width: 256, height: 1 }) });
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    (pool as unknown as { _texture: Texture })._texture = gradient;
    return { pool, gradient };
  }

  it('a heavy beam that hits: one solid core to its end point, at full width, no fade tail', () => {
    const { pool, gradient } = poolWithRealGradient();
    const b = heavy(0);
    const len = 3000;
    b.solidLen = remoteBeamSolidLen(HEAVY_BEAM_STYLE, len, true);
    pool.setBeams([b], 1, 0.03);
    const core = pool.coreAt(0)!;
    expect(core.texture, 'not the taper gradient').not.toBe(gradient);
    expect(pool.solidLenAt(0)).toBeCloseTo(len, 3);
    const tail = pool.fadeTailAt(0);
    expect(tail === null || !tail.visible).toBe(true);
    expect(core.width * 0.03).toBeCloseTo(HEAVY_BEAM_MIN_SCREEN_PX, 6);
  });

  it('even with no solid length the heavy beam draws solid (never the 55 % gradient)', () => {
    const { pool, gradient } = poolWithRealGradient();
    pool.setBeams([heavy(0)], 1, 1);
    expect(pool.coreAt(0)!.texture).not.toBe(gradient);
    expect(pool.solidLenAt(0)).toBeCloseTo(3000, 3);
  });

  it('a heavy beam that misses: solid almost all the way, a short fade at the very end', () => {
    const { pool } = poolWithRealGradient();
    const b = heavy(0);
    b.solidLen = remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, false);
    pool.setBeams([b], 1, 1);
    expect(pool.solidLenAt(0)!).toBeGreaterThanOrEqual(3000 * 0.75);
    expect(pool.fadeTailAt(0)!.visible).toBe(true);
  });

  it('a fighter beam still tapers on the gradient (unchanged)', () => {
    const { pool, gradient } = poolWithRealGradient();
    pool.setBeams([fighter(0), heavy(50)], 2, 1);
    expect(pool.coreAt(0)!.texture).toBe(gradient);
    expect(pool.solidLenAt(0)).toBeCloseTo(300, 3);
  });
});

/**
 * Owner 2026-11-15: "The beam could use some gradient or something, looks a
 * bit too pastel." It was one flat lavender bar. Across its width it now runs
 * from a white-hot core through saturated violet to soft glowing edges, on one
 * tiny texture every heavy beam shares (so they batch; no filter).
 */
describe('BeamSpritePool — the heavy beam has a hot core and glowing edges', () => {
  const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  /** Saturation of an RGB triple (HSV): 0 white/grey .. 1 pure colour. */
  const sat = (c: readonly number[]): number => {
    const mx = Math.max(c[0]!, c[1]!, c[2]!), mn = Math.min(c[0]!, c[1]!, c[2]!);
    return mx > 0 ? (mx - mn) / mx : 0;
  };
  const at = (d: number): number[] => crossSectionAt(HEAVY_BEAM_CROSS_SECTION, d, [0, 0, 0, 0]);

  it('the cross-section is brighter at its core than at its edges', () => {
    const px = crossSectionPixels(HEAVY_BEAM_CROSS_SECTION, 1, CROSS_SECTION_ROWS);
    const row = (y: number): number[] => [px[y * 4]!, px[y * 4 + 1]!, px[y * 4 + 2]!, px[y * 4 + 3]!];
    const mid = row(CROSS_SECTION_ROWS / 2), edge = row(0);
    expect(lum(mid)).toBeGreaterThan(lum(edge) + 150);
    expect(mid[3]).toBe(255);
    expect(edge[3]!, 'a soft edge, not a hard bar').toBeLessThan(40);
    // Brightness falls off steadily from the centre line out.
    for (let y = 1; y <= CROSS_SECTION_ROWS / 2; y++) expect(lum(row(y))).toBeGreaterThanOrEqual(lum(row(y - 1)));
  });

  it('the core is hotter (whiter) than the edge, the body a saturated violet', () => {
    const core = at(0), body = at(0.5), edge = at(0.9);
    expect(sat(core)).toBeLessThan(0.1); // near white
    expect(sat(body)).toBeGreaterThan(0.7); // deep, not pastel
    expect(sat(edge)).toBeGreaterThan(sat(core));
    expect(lum(core)).toBeGreaterThan(lum(edge));
    // Violet: blue strongest, then red, green least.
    expect(body[2]!).toBeGreaterThan(body[0]!);
    expect(body[0]!).toBeGreaterThan(body[1]!);
    expect(sat([(HEAVY_BEAM_DEEP_COLOR >> 16) & 255, (HEAVY_BEAM_DEEP_COLOR >> 8) & 255, HEAVY_BEAM_DEEP_COLOR & 255]))
      .toBeGreaterThan(sat([(HEAVY_BEAM_COLOR >> 16) & 255, (HEAVY_BEAM_COLOR >> 8) & 255, HEAVY_BEAM_COLOR & 255]));
  });

  it('the opaque body is the core width; the glow edges are drawn outside it', () => {
    const span = HEAVY_BEAM_CROSS_SECTION.span;
    expect(span).toBeGreaterThan(1);
    expect(at(1 / span - 0.02)[3]!).toBeGreaterThan(0.9);
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    pool.setBeams([heavy(0)], 1, 0.03);
    const c = pool.coreAt(0)!;
    expect(c.width * 0.03).toBeCloseTo(HEAVY_BEAM_MIN_SCREEN_PX, 6); // still >= 12 px of core
    expect(c.drawnWidth).toBeCloseTo(c.width * span, 6);
  });

  it('every heavy beam shares one texture; a hit runs on it at full strength to its end', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    const a = heavy(0), b = heavy(500);
    a.solidLen = remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, true);
    b.solidLen = remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, true);
    pool.setBeams([a, b], 2, 1);
    expect(pool.coreAt(0)!.texture).toBe(pool.coreAt(1)!.texture);
    expect(pool.solidLenAt(0)).toBeCloseTo(3000, 3);
    const tail = pool.fadeTailAt(0);
    expect(tail === null || !tail.visible).toBe(true);
  });

  it('a miss fades on the same cross-section (its tail keeps the gradient)', () => {
    const pool = new BeamSpritePool(REMOTE_BEAM_STYLE);
    const b = heavy(0);
    b.solidLen = remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, false);
    pool.setBeams([b], 1, 1);
    const tail = pool.fadeTailAt(0)!;
    expect(tail.visible).toBe(true);
    expect(tail.lenX).toBeCloseTo(3000 - b.solidLen!, 3);
  });
});
