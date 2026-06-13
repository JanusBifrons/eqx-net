/**
 * P1a regression — the beam "goes forever / never tapers" fix.
 *
 * Bug: the combat beam drew to its MAX range (optimal × maxRangeMul, e.g. 250 →
 * 375u) as one stretched-gradient sprite whose fade was anchored to a FRACTION of
 * the drawn length. So in empty space it read as a near-solid line running well
 * past the aim guide (250u) — "it draws it FOREVER… ZERO damage fall off" — and a
 * clipped hit faded prematurely before the target.
 *
 * Fix: a `taper` pool given an explicit `solidLen` draws a SOLID core
 * `[0, solidLen]` (clips solid at a real hit) plus a LINEAR fade TAIL
 * `[solidLen, len]` that fades to nothing across the falloff band, anchored in
 * WORLD units to the optimal→max range — not a fraction of the drawn length.
 */
import { describe, it, expect } from 'vitest';
import { BeamSpritePool } from './BeamSpritePool';

const TAPER_STYLE = { tint: 0x66ccff, width: 2, alpha: 1, taper: true } as const;
const SOLID_STYLE = { tint: 0xffb24d, width: 3, alpha: 1 } as const; // mining-style, no taper

function horizontalBeam(len: number, solidLen?: number) {
  // from (0,0) → (len, 0): rotation 0, so the fade tail starts at world x = solidLen.
  return { fromX: 0, fromY: 0, toX: len, toY: 0, solidLen };
}

describe('BeamSpritePool — solid core + falloff taper (P1a)', () => {
  it('no-hit beam: solid to the optimal range, a fade tail across the rest', () => {
    const pool = new BeamSpritePool(TAPER_STYLE);
    pool.setBeams([horizontalBeam(375, 250)], 1); // optimal 250, max 375

    expect(pool.solidLenAt(0)).toBeCloseTo(250, 3); // SOLID core stops at optimal range
    const tail = pool.fadeTailAt(0);
    expect(tail).not.toBeNull();
    expect(tail!.visible).toBe(true);
    expect(tail!.lenX).toBeCloseTo(125, 3); // fade tail covers 250 → 375
    expect(tail!.x).toBeCloseTo(250, 3); // tail begins where the solid core ends
  });

  it('hit beam (solidLen === total): solid to the hit, NO fade tail', () => {
    const pool = new BeamSpritePool(TAPER_STYLE);
    pool.setBeams([horizontalBeam(140, 140)], 1); // clipped at a target 140u away

    expect(pool.solidLenAt(0)).toBeCloseTo(140, 3); // solid all the way to the target
    const tail = pool.fadeTailAt(0);
    // Either no tail sprite was created, or it is hidden — never a premature fade.
    expect(tail === null || tail.visible === false).toBe(true);
  });

  it('hit within the optimal range stays fully solid (no premature fade)', () => {
    const pool = new BeamSpritePool(TAPER_STYLE);
    pool.setBeams([horizontalBeam(100, 100)], 1);
    expect(pool.solidLenAt(0)).toBeCloseTo(100, 3);
    const tail = pool.fadeTailAt(0);
    expect(tail === null || tail.visible === false).toBe(true);
  });

  it('legacy beam (no solidLen) draws a single full-length sprite, no tail', () => {
    const pool = new BeamSpritePool(TAPER_STYLE);
    pool.setBeams([horizontalBeam(300)], 1); // remote-style: solidLen undefined
    expect(pool.solidLenAt(0)).toBeCloseTo(300, 3);
    const tail = pool.fadeTailAt(0);
    expect(tail === null || tail.visible === false).toBe(true);
  });

  it('a NON-taper pool ignores solidLen (mining beam stays a solid full-length line)', () => {
    const pool = new BeamSpritePool(SOLID_STYLE);
    pool.setBeams([horizontalBeam(375, 250)], 1);
    expect(pool.solidLenAt(0)).toBeCloseTo(375, 3); // full length, no split
    const tail = pool.fadeTailAt(0);
    expect(tail === null || tail.visible === false).toBe(true);
  });

  it('the tail hides again when a subsequent frame clips the beam at a near hit', () => {
    const pool = new BeamSpritePool(TAPER_STYLE);
    pool.setBeams([horizontalBeam(375, 250)], 1); // frame 1: no hit → tail visible
    expect(pool.fadeTailAt(0)!.visible).toBe(true);
    pool.setBeams([horizontalBeam(120, 120)], 1); // frame 2: hit at 120 → tail off
    expect(pool.solidLenAt(0)).toBeCloseTo(120, 3);
    expect(pool.fadeTailAt(0)!.visible).toBe(false);
  });
});
