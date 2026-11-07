import type { Shot } from '../types.js';
import { sectorSites, warpDropPoint } from '../../src/core/galaxy/sectorSites.js';

/**
 * Phase 4 step 4 — in-sector warp-to (solar-system sectors): from Sol Prime's
 * home pocket to a gate pocket ~170 km out: a 3 s spool, the run, the drop on
 * the pocket's rim. Also the end-to-end lock for warp PREDICTION: the take's
 * pose-trace gate fails it on any correction or one-tick jump.
 */
export const warpTo: Shot = {
  id: 'warp-to',
  section: 'mechanics',
  title: 'Warp across the system',
  caption: 'Pick a destination in the system: the drive spools, the ship runs 170 km in seconds and drops out at the pocket.',
  features: ['P4'],
  docs: [],
  reel: false,
  server: 'solar',
  target: { galaxy: 'sol-prime', params: { solar: '1', spawnX: 0, spawnY: 0, art: 'machined', fx: 'new' } },
  hud: 'clean',
  durationMs: 18_000,
  async run(ctx) {
    await ctx.sleep(1500);
    const gate = sectorSites('sol-prime').find((s) => s.kind === 'gate')!;
    const drop = warpDropPoint(gate, 0, 0);
    await ctx.page.evaluate(`globalThis.__eqxClient && globalThis.__eqxClient.requestWarp(${drop.x}, ${drop.y})`);
  },
};
