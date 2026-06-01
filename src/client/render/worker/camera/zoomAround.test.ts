import { describe, it, expect } from 'vitest';
import { zoomAround, wheelZoomFactor, type ZoomTarget } from './zoomAround';

function makeTarget(scale = 1): ZoomTarget {
  return {
    x: 0,
    y: 0,
    scale: {
      x: scale,
      y: scale,
      set(s: number): void {
        this.x = s;
        this.y = s;
      },
    },
  };
}

describe('zoomAround', () => {
  it('keeps the world point under the anchor fixed in screen space', () => {
    const t = makeTarget(1);
    t.x = 37;
    t.y = -12;
    const anchorX = 200;
    const anchorY = 150;
    const worldBeforeX = (anchorX - t.x) / t.scale.x;
    const worldBeforeY = (anchorY - t.y) / t.scale.y;

    zoomAround(t, anchorX, anchorY, 2.5);

    const worldAfterX = (anchorX - t.x) / t.scale.x;
    const worldAfterY = (anchorY - t.y) / t.scale.y;
    expect(worldAfterX).toBeCloseTo(worldBeforeX);
    expect(worldAfterY).toBeCloseTo(worldBeforeY);
    expect(t.scale.x).toBe(2.5);
    expect(t.scale.y).toBe(2.5);
  });

  it('holds the anchor fixed across a sequence of incremental scales', () => {
    const t = makeTarget(0.8);
    t.x = 100;
    t.y = 50;
    const anchorX = 640;
    const anchorY = 360;
    const worldX = (anchorX - t.x) / t.scale.x;
    const worldY = (anchorY - t.y) / t.scale.y;
    for (const s of [0.9, 1.1, 1.7, 2.9, 0.6]) {
      zoomAround(t, anchorX, anchorY, s);
      expect((anchorX - t.x) / t.scale.x).toBeCloseTo(worldX);
      expect((anchorY - t.y) / t.scale.y).toBeCloseTo(worldY);
    }
  });
});

describe('wheelZoomFactor', () => {
  it('wheel down (deltaY > 0) zooms out (< 1)', () => {
    expect(wheelZoomFactor(120)).toBeLessThan(1);
  });
  it('wheel up (deltaY < 0) zooms in (> 1)', () => {
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1);
  });
});
