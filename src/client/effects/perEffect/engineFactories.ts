/**
 * Production factories for `EngineEmitter`. Isolates the Pixi import so
 * the manager + tests stay DOM-free.
 */

import { Graphics } from 'pixi.js';
import type { EngineFactories } from './EngineEmitter';

export function buildEngineFactories(): EngineFactories {
  return {
    makeParticle(tint: number): Graphics {
      const gfx = new Graphics();
      // Small dot — Graphics.circle is the v8 API.
      gfx.circle(0, 0, 2);
      gfx.fill({ color: tint, alpha: 1 });
      return gfx;
    },
  };
}
