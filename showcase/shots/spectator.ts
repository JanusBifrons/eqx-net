import type { Shot } from '../types.js';
import { AS_PILOT } from './_helpers.js';

/** M35 — instant spectator on death, free-roam camera, build with no ship. */
export const spectator: Shot = {
  id: 'spectator',
  section: 'mechanics',
  title: 'Spectator & construction',
  caption: 'Lose your ship and the camera detaches instantly — roam the sector and keep building.',
  features: ['M35'],
  docs: ['spectator-and-construction-mode'],
  reel: true,
  server: 'lean',
  ...AS_PILOT,
  target: { room: 'showcase-base', params: { zoom: 0.8 } },
  hud: 'clean',
  durationMs: 10_000,
  async run(ctx) {
    await ctx.sleep(1500);
    await ctx.page.evaluate(() =>
      (window as unknown as { __eqxKillLocalShip?: () => void }).__eqxKillLocalShip?.(),
    );
    await ctx.sleep(1200);
    // Pan from the spawn back across the base, then along it.
    await ctx.hold(['a', 's'], 2400);
    await ctx.hold(['a'], 1600);
    await ctx.hold(['d', 'w'], 1500);
  },
};
