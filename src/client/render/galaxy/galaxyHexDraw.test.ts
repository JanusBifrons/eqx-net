import { describe, it, expect } from 'vitest';
import { bakeNebulaAlpha, NEBULA_MAX_ALPHA } from './galaxyHexDraw';

describe('nebula backdrop bake', () => {
  const b = bakeNebulaAlpha(64);

  it('has cloud, capped at the peak opacity', () => {
    let max = 0;
    for (const a of b.alpha) max = Math.max(max, a);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(Math.round(NEBULA_MAX_ALPHA * 255));
  });

  it('fades to nothing at the grid border (no hard rectangle)', () => {
    for (let i = 0; i < b.w; i++) {
      expect(b.alpha[i]).toBeLessThanOrEqual(2);
      expect(b.alpha[(b.h - 1) * b.w + i]).toBeLessThanOrEqual(2);
    }
  });

  it('is soft: neighbouring texels never jump (no hard-edged discs)', () => {
    let worst = 0;
    for (let j = 0; j < b.h; j++) {
      for (let i = 1; i < b.w; i++) worst = Math.max(worst, Math.abs(b.alpha[j * b.w + i]! - b.alpha[j * b.w + i - 1]!));
    }
    expect(worst).toBeLessThan(20); // ~8% opacity per 8 px texel: a gradient, not an edge
  });
});
