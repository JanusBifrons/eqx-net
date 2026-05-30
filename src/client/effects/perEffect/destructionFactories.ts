/**
 * Production factories for `DestructionFx`. Separated from the manager so
 * the manager + its tests stay DOM-free.
 *
 * `new ShockwaveFilter()` calls `document.createElement('canvas')` for
 * shader-context probing under Pixi v8; instantiating it in a node-env
 * test throws `ReferenceError: document is not defined`. Keeping the
 * Pixi imports here isolates the side-effect.
 */

import { Graphics } from 'pixi.js';
import { ShockwaveFilter } from 'pixi-filters';
import { buildExplosionGfx } from '../../render/pixi/spriteBuilders';
import type { DestructionFactories, ShockwaveLike } from './DestructionFx';

export function buildDestructionFactories(): DestructionFactories {
  return {
    makeParticleGfx(tint: number): Graphics {
      const gfx = new Graphics();
      gfx.moveTo(0, -3);
      gfx.lineTo(2, 2);
      gfx.lineTo(-2, 2);
      gfx.fill({ color: tint, alpha: 1 });
      return gfx;
    },
    makeFallbackGfx(): Graphics {
      return buildExplosionGfx();
    },
    makeShockFilter(center: { x: number; y: number }): ShockwaveLike {
      return new ShockwaveFilter({
        center,
        speed: 800,
        amplitude: 40,
        wavelength: 120,
        brightness: 1.2,
        radius: -1,
        time: 0,
      }) as unknown as ShockwaveLike;
    },
  };
}
