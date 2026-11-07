import type { Shot } from '../types.js';

/**
 * Phase 4 travel state, step 3: sector to sector with no loading screen. The
 * pilot engages a transit from Sol Prime to Vega Reach. The 30 s spool runs
 * before the camera rolls (it isn't worth watching); the clip opens in its
 * last seconds, then the ship accelerates out of Sol Prime (the sector falls
 * behind), crosses empty space while Vega Reach loads underneath, and
 * decelerates into Vega Reach, which comes into view as it arrives.
 */
export const sectorTravel: Shot = {
  id: 'sector-travel',
  section: 'mechanics',
  title: 'Between sectors',
  caption: 'Jump to the next sector: you fly out of one and into the next. The trip itself hides the loading.',
  features: ['P4'],
  docs: ['travel-state'],
  reel: false,
  server: 'solar',
  target: { galaxy: 'sol-prime', params: { solar: '1', spawnX: 0, spawnY: 0, art: 'machined', fx: 'new' } },
  hud: 'clean',
  async prepare(ctx) {
    await ctx.page.evaluate(`(() => {
      const c = globalThis.__eqxClient;
      const room = c && c.getRoom && c.getRoom();
      if (room) room.send('engage_transit', { type: 'engage_transit', targetSectorKey: 'vega-reach' });
    })()`);
    ctx.log('transit engaged (sol-prime -> vega-reach); skipping most of the 30 s spool');
    await ctx.sleep(27_000);
  },
  durationMs: 38_000,
  async run(ctx) {
    await ctx.sleep(37_000);
  },
};
