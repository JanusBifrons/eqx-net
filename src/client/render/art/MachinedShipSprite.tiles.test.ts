/**
 * Capital-ship R&D round 3 E — a tiled hull's sprite stacks its tiles along
 * the hull (together they span exactly the hull's frame) and switches every
 * tile to the same two sun frames.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import { MachinedShipSprite } from './MachinedShipSprite.js';
import type { ShipArt } from './ArtService.js';
import { sunFrameBlend } from './machinedShipLight.js';

function art(tiles: number, suns: number): ShipArt {
  const frames: Texture[] = [];
  for (let i = 0; i < tiles * suns; i++) frames.push(new Texture());
  return { frames, w: 300, h: 2500, tiles, tileH: 1024, density: 0.5, nozzles: [], navLights: [] };
}

describe('MachinedShipSprite tiles', () => {
  it('stacks tiles from the top of the hull frame, one sprite pair per tile', () => {
    const a = art(3, 4);
    const s = new MachinedShipSprite(a);
    expect(s.children.length).toBe(6);
    // Tile tops in world units: (t * tileH - h / 2) / density.
    const tops = s.children.filter((_, i) => i % 2 === 0).map((c) => c.y);
    expect(tops).toEqual([-2500, -452, 1596]);
  });

  it('every tile shows the same two sun frames', () => {
    const a = art(3, 4);
    const s = new MachinedShipSprite(a);
    s.rotation = 1.1;
    s.updateLight(0.3);
    const blend = sunFrameBlend(0.3, 1.1, 4, { j0: 0, j1: 0, t: 0 });
    const kids = s.children as unknown as Array<{ texture: Texture; alpha: number }>;
    for (let t = 0; t < 3; t++) {
      expect(kids[t * 2]!.texture).toBe(a.frames[blend.j0 * 3 + t]);
      expect(kids[t * 2 + 1]!.texture).toBe(a.frames[blend.j1 * 3 + t]);
      expect(kids[t * 2 + 1]!.alpha).toBeCloseTo(blend.t);
    }
  });

  it('an untiled ship keeps one centred pair', () => {
    const a = { ...art(1, 16), h: 100, tileH: 100 };
    const s = new MachinedShipSprite(a);
    expect(s.children.length).toBe(2);
    expect(s.children[0]!.y).toBe(0);
  });
});
