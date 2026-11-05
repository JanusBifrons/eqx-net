/**
 * Ship engine exhaust (FxEngines): flame + ribbon per Machined nozzle.
 */
import { describe, expect, it } from 'vitest';
import { MeshRope, Sprite, Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxEngines, type Nozzle } from './FxEngines.js';

function fakeArt(ready = true): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: ready ? 'ready' : 'pending', ship: null, struct: null,
    fx: ready ? { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } : null });
  return { fx: () => h() } as unknown as ArtService;
}

const TWIN: Nozzle[] = [{ x: -4, y: 10, r: 2 }, { x: 4, y: 10, r: 2 }];
const ONE: Nozzle[] = [{ x: 0, y: 8, r: 2 }];
const DT = 1 / 60;

const visibleFlames = (fx: FxEngines): Sprite[] => fx.flameLayer.children.filter((c) => c.visible) as Sprite[];
const visibleRopes = (fx: FxEngines): MeshRope[] => fx.trailLayer.children.filter((c) => c.visible) as MeshRope[];

/** Fly ship `key` along +x (Pixi rot π/2 = nose toward +x) at `speed` for `frames`. */
function fly(fx: FxEngines, key: string, nz: Nozzle[], speed: number, frames: number, thrust: -1 | 0 | 1, boost: -1 | 0 | 1, x0 = 0): number {
  let x = x0;
  for (let f = 0; f < frames; f++) {
    fx.beginFrame();
    fx.draw(key, nz, x, 0, Math.PI / 2, thrust, boost, 800, DT, f * 16.7);
    fx.endFrame();
    x += speed * DT;
  }
  return x;
}

describe('FxEngines', () => {
  it('draws nothing until its textures are baked (the caller keeps today\'s emitter)', () => {
    const fx = new FxEngines(fakeArt(false));
    fx.beginFrame();
    expect(fx.draw('a', TWIN, 0, 0, 0, 1, 0, 800, DT, 0)).toBe(false);
    expect(fx.drew('a')).toBe(false);
  });

  it('a twin-engine hull gets a flame, core and ribbon at each nozzle', () => {
    const fx = new FxEngines(fakeArt());
    fly(fx, 'a', TWIN, 400, 30, 1, 0);
    expect(visibleFlames(fx)).toHaveLength(4); // flame + core per nozzle
    expect(visibleRopes(fx)).toHaveLength(2);
    expect(fx.drawn()).toBe(1);
  });

  it('flames point astern and grow from thrust to boost', () => {
    const fx = new FxEngines(fakeArt());
    fly(fx, 'a', ONE, 400, 60, 1, 0);
    const thrustLen = visibleFlames(fx)[0]!.scale.x;
    // Nose toward +x, so astern is -x: rotation π.
    expect(Math.cos(visibleFlames(fx)[0]!.rotation)).toBeCloseTo(-1, 5);
    fly(fx, 'a', ONE, 900, 60, 1, 1, 400);
    expect(visibleFlames(fx)[0]!.scale.x).toBeGreaterThan(thrustLen * 1.6);
  });

  it('a drone (no input) lights its engines from its speed', () => {
    const slow = new FxEngines(fakeArt()), fast = new FxEngines(fakeArt());
    fly(slow, 'd', ONE, 0, 60, -1, -1);
    fly(fast, 'd', ONE, 780, 60, -1, -1);
    const a = visibleFlames(slow)[0]!, b = visibleFlames(fast)[0]!;
    expect(b.scale.x).toBeGreaterThan(a.scale.x * 3);
    expect(b.tint).not.toBe(a.tint); // near top speed it reads as boost (blue)
  });

  it('a ship that is gone is hidden and its view reused', () => {
    const fx = new FxEngines(fakeArt());
    fly(fx, 'a', TWIN, 400, 10, 1, 0);
    const kids = fx.flameLayer.children.length;
    fx.beginFrame(); fx.endFrame();
    expect(visibleFlames(fx)).toHaveLength(0);
    fly(fx, 'b', TWIN, 400, 10, 1, 0);
    expect(fx.flameLayer.children.length).toBe(kids);
  });

  it('a teleport resets the ribbon instead of drawing it across the gap', () => {
    const fx = new FxEngines(fakeArt());
    fly(fx, 'a', ONE, 400, 30, 1, 0);
    fx.beginFrame();
    fx.draw('a', ONE, 50_000, 0, Math.PI / 2, 1, 0, 800, DT, 600);
    fx.endFrame();
    const rope = fx.trailLayer.children[0] as MeshRope;
    expect(rope.visible).toBe(false); // history restarted: one point only
  });

  it('low quality keeps the flames and drops the ribbons', () => {
    const fx = new FxEngines(fakeArt(), () => 'low');
    fly(fx, 'a', TWIN, 400, 30, 1, 0);
    expect(visibleFlames(fx)).toHaveLength(4);
    expect(visibleRopes(fx)).toHaveLength(0);
  });
});
