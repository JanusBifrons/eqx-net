/**
 * Round 2 sky in the game backdrop (plan iridescent-seeking-rainbow v5, C1):
 * each sector lays out its own landmarks, they are hidden off screen, and the
 * dust motes follow the quality tier.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
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
    const motes = (): number => b.fore.children.filter((c) => c.visible).length;
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
