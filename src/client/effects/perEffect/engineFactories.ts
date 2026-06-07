/**
 * Production factories for `EngineEmitter`. Isolates the Pixi import so
 * the manager + tests stay DOM-free.
 */

import { Graphics } from 'pixi.js';
import type { EngineFactories } from './EngineEmitter';

export function buildEngineFactories(): EngineFactories {
  return {
    // Punchy additive hot-core dot: a soft outer glow disc + a bright
    // near-white core, both baked WHITE so the per-frame `gfx.tint` drives
    // the white-hot → base → smoke colour ramp. `blendMode = 'add'` (set
    // once at construction) makes overlapping particles brighten into a
    // glowing plume. The `tint` arg is unused — colour is per-frame via
    // `gfx.tint` — but kept so the free-pool stays routed by kind.
    makeParticle(_tint: number): Graphics {
      const gfx = new Graphics();
      gfx.circle(0, 0, 5.5);
      gfx.fill({ color: 0xffffff, alpha: 0.5 }); // soft outer glow
      gfx.circle(0, 0, 2.4);
      gfx.fill({ color: 0xffffff, alpha: 0.95 }); // bright hot core
      gfx.blendMode = 'add';
      return gfx;
    },
  };
}
