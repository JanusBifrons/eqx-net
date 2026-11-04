/**
 * Production factories for `ImpactSparks`. Pixi-import isolation.
 *
 * With the new effects (`?fx=new`) and the glow texture baked, a spark is a
 * soft additive glow sprite (wrapped in a Container so ImpactSparks' scale
 * stays in world units); otherwise today's small dot.
 */

import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { ImpactFactories } from './ImpactSparks';

/** World size of a new-look spark (diameter at full scale). */
const FX_SPARK_SIZE = 9;

export function buildImpactFactories(fxGlow?: () => Texture | null): ImpactFactories {
  return {
    makeSpark(tint: number): Graphics {
      const glow = fxGlow?.() ?? null;
      if (glow) {
        const c = new Container();
        const s = new Sprite(glow);
        s.anchor.set(0.5);
        s.tint = tint;
        s.blendMode = 'add';
        s.scale.set(FX_SPARK_SIZE / glow.width);
        c.addChild(s);
        return c as unknown as Graphics;
      }
      const gfx = new Graphics();
      // Small bright dot — 1.5 px radius for a tight pop.
      gfx.circle(0, 0, 1.5);
      gfx.fill({ color: tint, alpha: 1 });
      return gfx;
    },
  };
}
