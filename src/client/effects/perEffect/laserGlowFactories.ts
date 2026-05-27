/**
 * Production factory for `LaserGlow`. Isolates the `pixi-filters` import
 * so the manager + tests stay DOM-free.
 *
 * `GlowFilter` (pixi-filters v6) is structurally a `Filter` subclass —
 * its constructor compiles a shader which under Pixi v8 / node throws
 * `document is not defined` exactly like `ShockwaveFilter`.
 */

import { GlowFilter } from 'pixi-filters';
import type { GlowLike, LaserGlowFactories } from './LaserGlow';

export function buildLaserGlowFactories(): LaserGlowFactories {
  return {
    makeGlowFilter(colour: number): GlowLike {
      return new GlowFilter({
        color: colour,
        outerStrength: 2,
        innerStrength: 1,
        quality: 0.2,
        // distance/alpha defaulted by pixi-filters
      }) as unknown as GlowLike;
    },
  };
}
