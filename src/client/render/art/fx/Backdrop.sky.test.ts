/**
 * Round 2 sky in the game backdrop (plan iridescent-seeking-rainbow v5, C1):
 * each sector lays out its own landmarks, they are hidden off screen, and the
 * dust motes follow the quality tier.
 */
import { describe, it, expect } from 'vitest';
import { Sprite, Texture, type Container } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { DEFAULT_RIG } from '../shade.js';
import { Backdrop } from './Backdrop.js';
import { nebulaDensity } from '../../../../core/galaxy/nebulaField.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../../shared-types/sectorBounds.js';

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
    // Sweep the whole sector (±5,000 u classic, ±200,000 u solar-system).
    const H = SECTOR_PLAYABLE_HALF_EXTENT;
    for (let x = -H; x <= H; x += H / 10) {
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

describe('Backdrop nebulae from the galaxy map (nebula sectors only)', () => {
  type Inner = { nebBack: Container; nebFront: Container };
  const shown = (c: Container): number => c.children.filter((k) => k.visible && k.alpha > 0.01).length;

  it('in a nebula sector: deep at the centre, cloud in front of the world, clear round the ship', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('bloomgate');
    b.update(cam(0, 0), 0);
    expect(b.density).toBeGreaterThan(0.95);
    const { nebBack, nebFront } = b as unknown as Inner;
    expect(shown(nebBack)).toBeGreaterThan(0);
    // Pan so puffs cross the screen; none is ever drawn at the centre.
    let fronts = 0;
    for (let x = 0; x < 20_000; x += 700) {
      b.update(cam(x, 0), 0);
      fronts += shown(nebFront);
      const centre = nebFront.children.filter((c) => c.visible && Math.hypot(c.x - 640, c.y - 360) < 80 && c.alpha > 0.02);
      expect(centre).toHaveLength(0);
    }
    expect(fronts).toBeGreaterThan(0);
  });

  it('thickness follows the shared nebula field, Y flipped (camera is Pixi space)', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('cygnus-arm');
    for (const [x, y] of [[0, 150_000], [0, -150_000], [150_000, 60_000], [-150_000, -60_000]] as const) {
      b.update(cam(x, -y), 0);
      expect(b.density).toBeCloseTo(nebulaDensity('cygnus-arm', x, y), 9);
    }
    expect(nebulaDensity('cygnus-arm', 0, 150_000)).not.toBeCloseTo(nebulaDensity('cygnus-arm', 0, -150_000), 2);
  });

  it('a clear sector has no fly-through cloud; leaving a nebula sector removes it', () => {
    const b = new Backdrop(fakeArt(), () => 'high');
    b.setSector('emberwake');
    b.update(cam(0, 0), 0);
    const { nebBack, nebFront } = b as unknown as Inner;
    expect(nebBack.children.length).toBeGreaterThan(0);
    b.setSector('sol-prime');
    for (let x = -150_000; x <= 150_000; x += 25_000) {
      b.update(cam(x, x / 2), 0);
      expect(b.density).toBe(0);
    }
    expect(nebBack.children.length + nebFront.children.length).toBe(0);
  });
});

describe('Backdrop speed effects (C3)', () => {
  const fly = (b: Backdrop, vx: number, vy: number): void => {
    let x = 0, y = 0;
    for (let f = 0; f <= 120; f++) { b.update(cam(x, y), f * 16); x += vx * 0.016; y += vy * 0.016; }
  };
  it('at boost the dust streaks along the motion and the camera is asked to zoom out', () => {
    const b = new Backdrop(fakeArt(), () => 'high', 'large');
    b.setSector('any');
    fly(b, 0, 900); // straight down the screen (Pixi Y-down)
    expect(b.speed.sf).toBeGreaterThan(0.9);
    expect(b.speedZoom()).toBeLessThan(0.83);
    const m = b.fore.children.find((c) => c instanceof Sprite && c.visible && Math.abs(c.scale.x / c.scale.y - 1) > 1)!;
    expect(m, 'a streaked mote').toBeDefined();
    expect(m.rotation).toBeCloseTo(Math.PI / 2, 2);
  });

  it('at rest, or with speed effects off, the dust is round and there is no zoom-out', () => {
    const rest = new Backdrop(fakeArt(), () => 'high', 'large');
    rest.setSector('any');
    fly(rest, 0, 0);
    expect(rest.speedZoom()).toBe(1);
    const off = new Backdrop(fakeArt(), () => 'high', 'off');
    off.setSector('any');
    fly(off, 0, 900);
    expect(off.speedZoom()).toBe(1);
    for (const b of [rest, off]) {
      const streaked = b.fore.children.filter((c) => c instanceof Sprite && c.visible && c.texture !== Texture.WHITE && Math.abs(c.scale.x / c.scale.y - 1) > 0.01);
      expect(streaked).toHaveLength(0);
    }
  });
});
