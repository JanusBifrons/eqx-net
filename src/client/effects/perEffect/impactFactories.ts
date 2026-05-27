/**
 * Production factories for `ImpactSparks`. Pixi-import isolation.
 */

import { Graphics } from 'pixi.js';
import type { ImpactFactories } from './ImpactSparks';

export function buildImpactFactories(): ImpactFactories {
  return {
    makeSpark(tint: number): Graphics {
      const gfx = new Graphics();
      // Small bright dot — 1.5 px radius for a tight pop.
      gfx.circle(0, 0, 1.5);
      gfx.fill({ color: tint, alpha: 1 });
      return gfx;
    },
  };
}
