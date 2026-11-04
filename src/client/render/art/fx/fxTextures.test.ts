/**
 * Effects textures (plan iridescent-seeking-rainbow v2): generated once, so
 * they must be deterministic and the right size, and the tileable ones must wrap.
 */
import { describe, it, expect } from 'vitest';
import {
  beamFlowTex, fireballFlipbook, glowTex, hexEdgeDist, imgGpuBytes, nebulaTex, pfbm, shieldHitFlipbook, starTileTex,
  type Img,
} from './fxTextures.js';

const alphaAt = (i: Img, x: number, y: number): number => i.data[(y * i.w + x) * 4 + 3]!;

describe('fx textures', () => {
  it('are deterministic', () => {
    expect(glowTex(32).data).toEqual(glowTex(32).data);
    expect(starTileTex(64, 40, 3).data).toEqual(starTileTex(64, 40, 3).data);
  });

  it('periodic noise wraps seamlessly', () => {
    for (const [u, v] of [[0.13, 0.4], [0.77, 0.02]] as const) {
      expect(pfbm(u, v, 4, 5, 9)).toBeCloseTo(pfbm(u + 1, v, 4, 5, 9), 9);
      expect(pfbm(u, v, 4, 5, 9)).toBeCloseTo(pfbm(u, v + 1, 4, 5, 9), 9);
    }
  });

  it('tileable textures match across their wrap edge', () => {
    // The step from the last column back to the first is no bigger than a
    // normal step between neighbouring columns.
    for (const tex of [nebulaTex('reflection', 96, 4), beamFlowTex(128, 16)]) {
      let edge = 0, inner = 0;
      for (let y = 0; y < tex.h; y++) {
        edge += Math.abs(alphaAt(tex, 0, y) - alphaAt(tex, tex.w - 1, y));
        inner += Math.abs(alphaAt(tex, tex.w >> 1, y) - alphaAt(tex, (tex.w >> 1) - 1, y));
      }
      expect(edge).toBeLessThanOrEqual(inner * 3 + tex.h * 2);
    }
  });

  it('flipbooks lay out every frame on one sheet, and the fireball fades', () => {
    const fb = fireballFlipbook(16, 32);
    expect(fb.frames).toBe(16);
    expect(fb.sheet.w).toBe(fb.cols * 32);
    const sum = (f: number): number => {
      let s = 0;
      const ox = (f % fb.cols) * 32, oy = Math.floor(f / fb.cols) * 32;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) s += alphaAt(fb.sheet, ox + x, oy + y);
      return s;
    };
    expect(sum(15)).toBeLessThan(sum(1));
    expect(shieldHitFlipbook(8, 32).frames).toBe(8);
  });

  it('the hex grid has edges at 0 and centres near 0.5', () => {
    expect(hexEdgeDist(0, 0)).toBeCloseTo(0.5, 5);
    expect(hexEdgeDist(0.5, 0)).toBeLessThan(0.05);
  });

  it('GPU bytes count RGBA8, plus a third for mipmaps', () => {
    const i = glowTex(64);
    expect(imgGpuBytes([i])).toBe(64 * 64 * 4);
    expect(imgGpuBytes([i], true)).toBe(Math.round((64 * 64 * 4 * 4) / 3));
  });
});
