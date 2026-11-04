/**
 * New shields and fences (plan iridescent-seeking-rainbow v3, B5).
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxFences, FxShields, type ShieldPoseFn } from './FxShields.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 12 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}
const at = (x: number, y: number): ShieldPoseFn => (_id, out) => { out.x = x; out.y = y; return true; };
const visible = (c: { children: Array<{ visible: boolean }> }): number => c.children.filter((k) => k.visible).length;

describe('FxShields', () => {
  it('a shield at rest draws nothing', () => {
    const s = new FxShields(fakeArt());
    for (let f = 0; f < 5; f++) { s.begin(); s.shield('a', 40); s.end(f * 16, at(0, 0)); }
    expect(visible(s.container)).toBe(0);
  });

  it('a hit plays a ripple facing where it landed', () => {
    const s = new FxShields(fakeArt());
    s.begin(); s.shield('a', 40); s.end(0, at(0, 0));
    s.begin(); s.hitAt('a', 0, 40, 16, at(0, 0)); s.shield('a', 40); s.end(32, at(0, 0)); // hit from "above" in game space
    const drawn = s.container.children.filter((k) => k.visible);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.rotation).toBeCloseTo(-Math.PI / 2); // Pixi y-down: up is -pi/2
  });

  it('a laser on the shield is one steady contact that stays lit while the beam holds', () => {
    const s = new FxShields(fakeArt());
    const alphas: number[] = [];
    for (let f = 0; f < 40; f++) {
      s.begin(); s.beam('a', 7, 40, 0, at(0, 0)); s.shield('a', 40); s.end(f * 16, at(0, 0));
      const lit = s.container.children.filter((k) => k.visible && k.alpha > 0.5);
      alphas.push(lit.length);
    }
    expect(alphas.slice(10).every((n) => n >= 1)).toBe(true);
  });

  it('a shield that goes down plays its break, then frees', () => {
    const s = new FxShields(fakeArt());
    s.begin(); s.shield('a', 40); s.end(0, at(0, 0));
    s.begin(); s.end(100, at(0, 0)); // not reported: went down
    expect(visible(s.container)).toBeGreaterThan(0);
    s.begin(); s.end(100 + 900, at(0, 0));
    expect(s.count()).toBe(0);
    expect(visible(s.container)).toBe(0);
  });
});

describe('FxFences', () => {
  it('an up fence draws segments + posts; a removed fence frees', () => {
    const f = new FxFences(fakeArt());
    f.begin(); f.wall(1, 0, 0, 200, 0, true, false, 0); f.end(0);
    expect(visible(f.container)).toBeGreaterThan(2);
    f.begin(); f.end(16);
    expect(f.count()).toBe(0);
    expect(visible(f.container)).toBe(0);
  });

  it('first sight of a fence does not play the raise; going down then up does', () => {
    const f = new FxFences(fakeArt());
    f.begin(); f.wall(1, 0, 0, 400, 0, true, false, 0); f.end(0);
    const full = f.container.children.filter((k) => k.visible && k.alpha > 0.5).length;
    f.begin(); f.wall(1, 0, 0, 400, 0, false, false, 1000); f.end(1000);
    f.begin(); f.wall(1, 0, 0, 400, 0, true, false, 2000); f.end(2050); // 50 ms into the raise
    const raising = f.container.children.filter((k) => k.visible && k.alpha > 0.5).length;
    expect(raising).toBeLessThan(full);
  });

  it('a powerless fence sparks at its posts; an open gate does not', () => {
    const f = new FxFences(fakeArt());
    f.begin(); f.wall(1, 0, 0, 200, 0, false, false, 0); f.wall(2, 0, 50, 200, 50, false, true, 0); f.end(5000);
    // Sparks are the last 4 sprites of each view; only fence 1 shows any.
    const kids = f.container.children;
    const per = kids.length / 2;
    const sparks1 = kids.slice(per - 4, per).some((k) => k.visible);
    const sparks2 = kids.slice(per * 2 - 4).some((k) => k.visible);
    expect(sparks1).toBe(true);
    expect(sparks2).toBe(false);
  });
});
