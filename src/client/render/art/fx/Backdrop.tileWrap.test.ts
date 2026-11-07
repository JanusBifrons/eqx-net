/**
 * Phone run 2026-11-07, after a sector trip: "laggy or jerky/jumpy stars".
 * A trip shifts the sky by the whole distance flown (measured: 287,182 units
 * Sol Prime -> Vega Reach), so the star tiles' texture offset grew to tens of
 * thousands of pixels. Phone GPUs often sample with half precision, which is
 * only good to whole pixels (or worse) at that size: the stars jumped. A tiled
 * layer repeats every texture width, so its offset must stay within one tile.
 */
import { describe, it, expect } from 'vitest';
import { Texture, TextureSource, TilingSprite } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { DEFAULT_RIG } from '../shade.js';
import { Backdrop } from './Backdrop.js';

const TEX = new Texture({ source: new TextureSource({ width: 512, height: 512 }) });

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: DEFAULT_RIG, state: 'ready', ship: null, struct: null,
    fx: { tex: TEX, frames: [TEX], w: 512, h: 512 } });
  return { fx: () => h(), lightRig: DEFAULT_RIG } as unknown as ArtService;
}
const cam = (x: number, y: number, zoom = 1) => ({ center: { x, y }, scale: { x: zoom }, screenWidth: 411, screenHeight: 785 });

function tiles(b: Backdrop): TilingSprite[] {
  return b.sky.children.filter((c): c is TilingSprite => c instanceof TilingSprite && c.visible);
}

describe('backdrop star tiles stay precise far from the origin', () => {
  it('after a long trip every tile offset stays within one tile', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('vega-reach');
    b.update(cam(0, 287_182), 0);
    const ts = tiles(b);
    expect(ts.length).toBeGreaterThan(0);
    for (const t of ts) {
      const px = TEX.width * t.tileScale.x, py = TEX.height * t.tileScale.y;
      expect(Math.abs(t.tilePosition.x)).toBeLessThanOrEqual(px);
      expect(Math.abs(t.tilePosition.y)).toBeLessThanOrEqual(py);
    }
  });

  it('wrapping does not move the stars: the offset is the same modulo one tile', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('vega-reach');
    const near: Array<[number, number, number]> = [];
    b.update(cam(1234, 567), 0);
    for (const t of tiles(b)) near.push([t.tilePosition.x, t.tilePosition.y, TEX.width * t.tileScale.x]);
    // Move the camera by a whole number of tile periods for the first layer:
    // the same layer must land on the same (wrapped) offset.
    b.update(cam(1234, 567), 16);
    const again = tiles(b);
    for (let i = 0; i < near.length; i++) {
      expect(again[i]!.tilePosition.x).toBeCloseTo(near[i]![0], 6);
      expect(again[i]!.tilePosition.y).toBeCloseTo(near[i]![1], 6);
    }
  });
});
