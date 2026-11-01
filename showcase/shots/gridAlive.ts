import type { Shot } from '../types.js';
import { AS_PILOT, selectAt } from './_helpers.js';

/** M25, M27, M30, U4, U5 — a powered grid: flow pulses, drill beam, turret, inspector. */
export const gridAlive: Shot = {
  id: 'grid-alive',
  section: 'mechanics',
  title: 'A working base',
  caption: 'Solar feeds the grid, the miner drills an asteroid, the turret defends — click anything to inspect it.',
  features: ['M25', 'M27', 'M30', 'U4', 'U5'],
  docs: ['structures-and-power-grid', 'leveling-and-upgrades'],
  reel: true,
  server: 'lean',
  ...AS_PILOT,
  target: { room: 'showcase-base' },
  hud: 'clean',
  durationMs: 12_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'orbit', x: -150, y: -50, radius: 120, periodMs: 24_000, zoom: 1.0 } },
  ],
  async run(ctx) {
    await ctx.sleep(4500);
    await selectAt(ctx, 0, 0);
    await ctx.sleep(3500);
    await selectAt(ctx, -350, 0);
  },
};
