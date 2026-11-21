import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { drawStatusBar, STATUS_BAR_MAX_H_PX, STATUS_BAR_MAX_W_PX } from './structureStatusMarks.js';

/** Records the rects drawStatusBar draws: [track, fill]. */
function recorder(): { g: Graphics; rects: { x: number; y: number; w: number; h: number }[] } {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const g = {
    rect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }); return g; },
    fill() { return g; },
  };
  return { g: g as unknown as Graphics, rects };
}

describe('drawStatusBar (construction / reclaim / charge bar above a structure)', () => {
  it('a huge structure (Shipyard, r 567) keeps its bar a small bar on screen, not ~570 px wide', () => {
    // Owner play-test, sideways phone ~863x400 in Build mode: a Shipyard under
    // construction drew a 2r-wide, 0.18r-thick bar (~560 px x 50 px on screen)
    // across the HUD and the inspector.
    const scale = 0.5; // world -> screen px (default zoom)
    const { g, rects } = recorder();
    drawStatusBar(g, 1000, 2000, 567, 0.4, 0x66ccff, scale);
    const [track, fill] = rects;
    expect(track!.w * scale).toBeLessThanOrEqual(STATUS_BAR_MAX_W_PX);
    expect(track!.h * scale).toBeLessThanOrEqual(STATUS_BAR_MAX_H_PX);
    // Still centred over the structure, the fill a share of the track.
    expect(track!.x + track!.w / 2).toBeCloseTo(1000);
    expect(fill!.x).toBe(track!.x);
    expect(fill!.w).toBeCloseTo(track!.w * 0.4);
    expect(fill!.h).toBe(track!.h);
    // Above the structure's bounding circle.
    expect(track!.y + track!.h).toBeLessThan(2000 - 567);
  });

  it('a small structure keeps its old bar (2r wide, max(3, 0.18r) thick)', () => {
    const { g, rects } = recorder();
    drawStatusBar(g, 0, 0, 40, 1, 0x66ccff, 0.5);
    expect(rects[0]!.w).toBeCloseTo(80);
    expect(rects[0]!.h).toBeCloseTo(7.2);
    expect(rects[0]!.x).toBeCloseTo(-40);
  });

  it('clamps the fill to the track', () => {
    const { g, rects } = recorder();
    drawStatusBar(g, 0, 0, 567, 3, 0x66ccff, 0.5);
    expect(rects[1]!.w).toBeCloseTo(rects[0]!.w);
    const r2 = recorder();
    drawStatusBar(r2.g, 0, 0, 567, -1, 0x66ccff, 0.5);
    expect(r2.rects[1]!.w).toBe(0);
  });
});
