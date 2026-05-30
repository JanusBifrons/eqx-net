/**
 * Production factories for `ShieldAura`. Pixi-import isolation.
 */

import { Container, Graphics } from 'pixi.js';
import { GlowFilter } from 'pixi-filters';
import type { GlowLike } from './LaserGlow';
import type { ShieldFactories } from './ShieldAura';

export function buildShieldFactories(): ShieldFactories {
  return {
    makeRing(radius: number): Graphics {
      const gfx = new Graphics();
      gfx.circle(0, 0, radius);
      gfx.stroke({ color: 0x88ddff, width: 2, alpha: 1 });
      return gfx;
    },
    makeGlowFilter(): GlowLike {
      // Defensive: GlowFilter under Pixi v8 calls document.createElement
      // at construct (shader-context probe). Node tests can hit this path
      // when EffectsService.tick fires the first tier transition. Return
      // a stub on failure so the manager keeps working (filter attach is
      // a no-op visually, but the rest of the aura still renders).
      try {
        return new GlowFilter({
          color: 0xaaffff,
          outerStrength: 1.5,
          innerStrength: 0.8,
          quality: 0.15,
        }) as unknown as GlowLike;
      } catch {
        return { outerStrength: 0, innerStrength: 0, quality: 0, color: 0 } as unknown as GlowLike;
      }
    },
    makeContainer(): Container {
      return new Container();
    },
  };
}
