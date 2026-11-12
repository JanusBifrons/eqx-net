/**
 * Naval shell impact bursts (shells as events, slice 4).
 *
 * A burst comes only from a `shell_end` (the `[x, y, shellRadius]` triples
 * queued in `mirror.pendingShellEnds`), so a miss or a shell that leaves view
 * never bursts. The burst lands on the drawn point, not its Y mirror.
 *
 * Reported (showcase review 2026-11-10, clip `capital-guns-fighter`): "the 5"
 * shells reach the fighter and its shield ring lights, but the hit burst
 * spawns about 380 px STRAIGHT ABOVE the fighter". Cause: a Pixi-space `-y`
 * handed to `FxExplosions.spawn`, which takes GAME space and flips Y itself.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxExplosions } from './FxExplosions.js';
import { FxProjectiles } from './FxWeapons.js';
import { NavalShellBursts } from './navalShellBursts.js';
import { shellImpactRadius } from './turretFx.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

describe('NavalShellBursts', () => {
  it('bursts a shell_end on the Pixi point the shell sprite was drawn on (not its Y mirror)', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    const drawn: Array<{ x: number; y: number }> = [];
    fx.onSpawn = (x, y): void => { drawn.push({ x, y }); };
    // A 5" shell drawn at the fighter (1500, -1800), game space.
    const proj = new FxProjectiles(fakeArt());
    proj.beginFrame();
    proj.draw('s1', 'shell', 1500, -1800, 2400, -1200, 1, 1);
    proj.endFrame();
    const sprite = proj.container.children.find((c) => c.visible)!;
    expect({ x: sprite.position.x, y: sprite.position.y }).toEqual({ x: 1500, y: 1800 });

    new NavalShellBursts().frame(fx, 1000, [1500, -1800, 3]);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.x).toBeCloseTo(sprite.position.x, 6);
    expect(drawn[0]!.y).toBeCloseTo(sprite.position.y, 6);
    fx.tick(1050);
    const fire = fx.fireLayer.children.filter((c) => c.visible && c.position.x === 1500 && c.position.y === 1800);
    expect(fire.length).toBeGreaterThan(0);
  });

  it('no shell_end, no burst; every end in the queue bursts at its blast size', () => {
    const at: Array<{ x: number; y: number; r: number }> = [];
    const sink = { spawn: (x: number, y: number, r: number): boolean => { at.push({ x, y, r }); return true; } };
    const b = new NavalShellBursts();
    b.frame(sink, 0);
    b.frame(sink, 16, []);
    expect(at).toHaveLength(0);
    b.frame(sink, 32, [4200, -50, 6, 100, 200, 3]);
    expect(at).toEqual([
      { x: 4200, y: -50, r: shellImpactRadius(6) },
      { x: 100, y: 200, r: shellImpactRadius(3) },
    ]);
  });
});
