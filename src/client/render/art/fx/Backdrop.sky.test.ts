/**
 * Round 2 sky in the game backdrop (plan iridescent-seeking-rainbow v5, C1):
 * each sector lays out its own landmarks, they are hidden off screen, and the
 * dust motes follow the quality tier.
 */
import { describe, it, expect } from 'vitest';
import { Sprite, Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { DEFAULT_RIG } from '../shade.js';
import { Backdrop } from './Backdrop.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: DEFAULT_RIG, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
  return { fx: () => h(), lightRig: DEFAULT_RIG } as unknown as ArtService;
}
const cam = (x: number, y: number, zoom = 1) => ({ center: { x, y }, scale: { x: zoom }, screenWidth: 1280, screenHeight: 720 });

describe('Backdrop sky (C1)', () => {
  it('every sector gets its own sky', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('sol-prime');
    const a = b.skySignature;
    b.setSector('vega-reach');
    expect(b.skySignature).not.toBe(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('shows only the landmarks near the camera, and they change as you travel', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('emerald-span');
    const seen = new Set<number>();
    for (let x = -5000; x <= 5000; x += 500) {
      b.update(cam(x, 0), 0);
      expect(b.visibleLandmarks).toBeLessThanOrEqual(40);
      seen.add(b.visibleLandmarks);
    }
    expect(seen.size).toBeGreaterThan(1); // the count changes along the way
  });

  it('dust motes follow the quality tier', () => {
    let q = 'high';
    const b = new Backdrop(fakeArt(), () => q);
    const motes = (): number => b.fore.children.filter((c) => c.visible && c instanceof Sprite).length;
    b.update(cam(0, 0), 0);
    const high = motes();
    q = 'medium'; b.update(cam(0, 0), 0);
    const medium = motes();
    q = 'low'; b.update(cam(0, 0), 0);
    expect(high).toBeGreaterThan(medium);
    expect(motes()).toBe(0);
  });
});

describe('Backdrop sky is endless (C1)', () => {
  it('still draws landmarks a million units from the centre', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('any');
    let seen = 0;
    for (let x = 1_000_000; x < 1_000_000 + 40 * 5000; x += 5000) { b.update(cam(x, 0), 0); seen += b.visibleLandmarks; }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('Backdrop nebula volumes (C2)', () => {
  it('inside a nebula: density is high, slices draw, and the middle stays clear', async () => {
    const { hashKey, nebulaCell } = await import('./depth.js');
    const g = { x: 0, y: 0, r: 0, variant: 'emission' as const, seed: 0 } as import('./depth.js').NebulaRegion;
    // A region away from y = 0, so a Y-flip mistake misses it.
    for (let i = 0; !nebulaCell(hashKey('neb:any'), i, -2, g); i++);
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('any');
    // The renderer camera is Pixi space (Y down): a game point (x, y) is centre (x, -y).
    b.update(cam(g.x, -g.y), 0);
    expect(b.density).toBeGreaterThan(0.9);
    const fronts = b.fore.children.filter((c) => c.visible && c.alpha > 0 && c.alpha < 0.2);
    expect(fronts.length).toBeGreaterThan(0);
    // Nothing in front of the world is opaque at the screen centre.
    const centre = b.fore.children.filter((c) => c.visible && Math.hypot(c.x - 640, c.y - 360) < 100 && c.alpha > 0.05 && c.width > 50);
    expect(centre).toHaveLength(0);
  });

  it('far from any nebula: density 0', async () => {
    const { hashKey, nebulaDensityAtSeed } = await import('./depth.js');
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('any');
    // Walk until a point outside every region.
    let x = 0;
    while (nebulaDensityAtSeed(hashKey('neb:any'), x, 0, { x: 0, y: 0, r: 0, variant: 'emission', seed: 0 }) > 0) x += 1000;
    b.update(cam(x, 0), 0);
    expect(b.density).toBe(0);
  });
});
