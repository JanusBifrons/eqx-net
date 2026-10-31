import type { Shot } from '../types.js';
import { sendRoom } from './_helpers.js';

/** M39, U3 — engage a warp: spool (time-cut), hyperspace, arrival in the next sector. */
export const warp: Shot = {
  id: 'warp',
  section: 'mechanics',
  title: 'Hyperspace',
  caption: 'Warping is a commitment: a 30-second spool you can be shot out of, then the jump to the next sector.',
  features: ['M39', 'U3'],
  docs: ['warp-visual', 'galaxy-graph', 'configurable-arrival'],
  reel: true,
  server: 'living',
  target: { galaxy: 'sol-prime', params: { spawnX: 400, spawnY: -200 } },
  hud: 'full',
  durationMs: 44_000,
  // The 30 s spool is real; the edit keeps its start and end.
  cuts: [{ fromMs: 5000, toMs: 27_500, label: 'spool' }],
  async run(ctx) {
    await ctx.sleep(1500);
    await sendRoom(ctx, 'engage_transit', { type: 'engage_transit', targetSectorKey: 'cygnus-arm' });
  },
};
