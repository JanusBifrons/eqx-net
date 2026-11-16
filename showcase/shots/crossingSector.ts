import type { Shot } from '../types.js';

/**
 * Round 2 sky (plan iridescent-seeking-rainbow v5, C4): a boosted run across
 * a sector, through a nebula you can fly into, with planets and moons
 * drifting past at their own depths and the speed effects (dust streaks, the
 * slight zoom-out) at their "large" strength.
 *
 * No camera script on purpose: the cinematic director is never speed-zoomed,
 * so this shot uses the normal follow camera. `test-sector` has no sector key,
 * so its sky is seeded from "none" and it is not a galaxy nebula sector
 * (nebulae sit only on the galaxy map's nebula marks, core/galaxy/nebulaField);
 * the shot asks for the signed-off nebula look with `neblook` (blend, seed 8),
 * which puts the whole room inside it. The capture browser is automated, so
 * the shot asks for the new look explicitly.
 */
export const crossingSector: Shot = {
  id: 'crossing-sector',
  section: 'mechanics',
  title: 'Crossing a sector',
  caption: 'Seven layers of depth, a sky of its own in every sector, nebulae you fly through, and dust that streaks past at speed.',
  features: ['ART'],
  docs: ['art-direction'],
  reel: true,
  server: 'lean',
  target: {
    room: 'test-sector',
    params: { shipKind: 'fighter', art: 'machined', fx: 'new', neblook: 'blend', nebseed: 8, speedfx: 1, spawnX: -4408, spawnY: -8600, initialAngle: 0, zoom: 1 },
  },
  hud: 'none',
  durationMs: 16_000,
  async run(ctx) {
    await ctx.hold(['w'], 1500);
    await ctx.hold(['w', 'ShiftLeft'], 6000);
    await ctx.hold(['w', 'a'], 700);
    await ctx.hold(['w', 'ShiftLeft'], 4000);
    await ctx.hold([], 2500);
  },
};
