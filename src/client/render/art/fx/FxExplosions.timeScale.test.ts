/**
 * Game time scale (stream step 4c): presentation follows the speed with no
 * effect-specific code. The renderer hands every effect `fxNow()`, a
 * GameClock over the wall clock at the sector's speed. This drives a real,
 * unmodified effect (FxExplosions knows nothing about time scale) with such a
 * clock: at 0.5× a burst lives twice as long in WALL time, at 2× half as long.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxExplosions, fireballLife } from './FxExplosions.js';
import { GameClock } from '../../../../core/clock/GameClock.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

/** Wall ms until a burst spawned now is freed, ticking every 10 wall ms. */
function wallLifeMs(speed: number): number {
  let wall = 1000;
  const fxClock = new GameClock(() => wall);
  fxClock.setScale(speed);
  const fx = new FxExplosions(fakeArt(), () => 'high');
  fx.spawn(0, 0, 100, fxClock.now());
  const start = wall;
  while (fx.activeCount() > 0 && wall - start < 60_000) {
    wall += 10;
    fx.tick(fxClock.now());
  }
  return wall - start;
}

describe('an unmodified effect follows the sector speed through fxNow() (time scale 4c)', () => {
  it('lives 2× as long at 0.5× and half as long at 2×', () => {
    const at1 = wallLifeMs(1);
    expect(at1).toBeGreaterThan(fireballLife(100) * 1000 * 0.5);
    expect(wallLifeMs(0.5) / at1).toBeCloseTo(2, 1);
    expect(wallLifeMs(2) / at1).toBeCloseTo(0.5, 1);
  });
});
