import type { Shot } from '../types.js';

/**
 * Round 2 sky (plan iridescent-seeking-rainbow v5, C4): a boosted run across
 * a sector, through a nebula you can fly into, with planets and moons
 * drifting past at their own depths and the speed effects (dust streaks, the
 * slight zoom-out) at their "large" strength.
 *
 * No camera script on purpose: the cinematic director is never speed-zoomed,
 * so this shot uses the normal follow camera. `test-sector` has no sector key,
 * so its sky is seeded from "none"; the run starts south of the nebula at
 * (-4408, -5105) (radius 2753, the first one `nebulaCell` finds near the
 * centre) and flies north through its middle. The capture browser is
 * automated, so the shot asks for the new look explicitly.
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
    params: { shipKind: 'fighter', art: 'machined', fx: 'new', speedfx: 1, spawnX: -4408, spawnY: -8600, initialAngle: 0, zoom: 1 },
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
