import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** M6 + M17 — composite hulls break into one scrap piece per component. */
export const scrap: Shot = {
  id: 'scrap',
  section: 'mechanics',
  title: 'Scrap on death',
  caption: 'Composite ships come apart component by component — the debris is physical and can be shoved around.',
  features: ['M6', 'M17'],
  docs: ['composite-ships-and-scrap'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test-scrap', params: { shipKind: 'missile-frigate', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 13_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 0, zoom: 1.25 } },
    { atMs: 7500, smoothMs: 500, shot: { kind: 'track', target: 'local', zoom: 1.4 } },
  ],
  async run(ctx) {
    await ctx.sleep(7500);
    await ctx.hold(['w'], 1200);
    await ctx.hold(['w', 'ShiftLeft'], 1500);
    await ctx.hold(['a', 'w'], 1500);
  },
};
