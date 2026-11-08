/**
 * Warp spool-up: the engines overcharge (2026-11-08). The user asked for a
 * look that "works on all ships and is configurable as it won't always be
 * 3s": it is driven by charge PROGRESS and sized from each ship's nozzles.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Sprite } from 'pixi.js';
import { WarpSpoolFx, mixColor, type SpoolFxShip } from './WarpSpoolFx.js';

function ship(progress: number, nozzles = 2): SpoolFxShip {
  const nz = [];
  for (let i = 0; i < nozzles; i++) nz.push({ x: (i - (nozzles - 1) / 2) * 6, y: 20, r: 3 });
  return { x: 0, y: 0, rotation: 0, progress, nozzles: nz, half: 20 };
}
const glows = (fx: WarpSpoolFx): Graphics[] => fx.layer.children.filter((c): c is Graphics => c instanceof Graphics && c.visible);
const sparks = (fx: WarpSpoolFx): number => fx.layer.children.filter((c) => c instanceof Sprite && c.visible).length;

describe('WarpSpoolFx (engines overcharge)', () => {
  it('one glow + core per real nozzle, any count (a fighter or a capital)', () => {
    for (const n of [1, 2, 9]) {
      const fx = new WarpSpoolFx();
      fx.beginFrame(0, 1); fx.draw('a', ship(0.5, n)); fx.endFrame();
      expect(glows(fx).length).toBe(n * 2);
    }
  });

  it('builds with charge progress, not seconds: bigger glow and more sparks', () => {
    const fx = new WarpSpoolFx();
    fx.beginFrame(1000, 1); fx.draw('a', ship(0.1)); fx.endFrame();
    const r0 = Math.max(...glows(fx).map((g) => g.scale.x)), s0 = sparks(fx);
    fx.beginFrame(1016, 1); fx.draw('a', ship(0.95)); fx.endFrame();
    const r1 = Math.max(...glows(fx).map((g) => g.scale.x)), s1 = sparks(fx);
    expect(r1).toBeGreaterThan(r0 * 1.5);
    expect(s1).toBeGreaterThan(s0);
  });

  it('not spooling hides everything; a ship that left is freed', () => {
    const fx = new WarpSpoolFx();
    fx.beginFrame(0, 1); fx.draw('a', ship(0.5)); fx.endFrame();
    fx.beginFrame(16, 1); fx.draw('a', ship(-1)); fx.endFrame();
    expect(glows(fx).length + sparks(fx)).toBe(0);
    fx.beginFrame(32, 1); fx.endFrame();
    expect(fx.layer.children.length).toBe(0);
  });

  it('mixColor blends', () => {
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
});
