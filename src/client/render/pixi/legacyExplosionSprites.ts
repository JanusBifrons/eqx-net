/**
 * The `?effects=0` fallback death explosion: a `buildExplosionGfx` burst that
 * grows and fades over 30 frames. Split out of `PixiRenderer.ts` (god-file
 * budget); the EffectsService path manages its own particles.
 */
import type { Container, Graphics } from 'pixi.js';
import { buildExplosionGfx } from './spriteBuilders.js';

const LIFE_FRAMES = 30;

export class LegacyExplosionSprites {
  private readonly live: Array<{ gfx: Graphics; framesLeft: number }> = [];

  /** Adds one burst at (`x`, `y`) (Pixi space) to `parent`. */
  spawn(parent: Container, x: number, y: number): void {
    const gfx = buildExplosionGfx();
    gfx.x = x;
    gfx.y = y;
    parent.addChild(gfx);
    this.live.push({ gfx, framesLeft: LIFE_FRAMES });
  }

  /** Advances every burst one frame; removes and destroys the expired. */
  tick(parent: Container): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]!;
      e.framesLeft--;
      e.gfx.alpha = e.framesLeft / LIFE_FRAMES;
      e.gfx.scale.set(1 + (1 - e.framesLeft / LIFE_FRAMES) * 1.5);
      if (e.framesLeft <= 0) {
        parent.removeChild(e.gfx);
        e.gfx.destroy();
        this.live.splice(i, 1);
      }
    }
  }
}
