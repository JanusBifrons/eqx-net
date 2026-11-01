import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** U8, T8 — the same game on a phone: touch layout, slot-anchored HUD. */
export const mobile: Shot = {
  id: 'mobile',
  section: 'tech',
  title: 'Phone-ready',
  caption: 'The same client on mobile — touch controls, an adaptive layout and a renderer path tuned for phones.',
  features: ['U8', 'T8'],
  docs: ['mobile-layout', 'mobile-perf-investigation'],
  reel: true,
  server: 'lean',
  viewport: 'phone',
  target: { room: 'feel-test', params: { shipKind: 'fighter', ...SURVIVE } },
  hud: 'clean',
  durationMs: 10_000,
  async run(ctx) {
    await ctx.hold(['w'], 2500);
    await ctx.hold(['w', 'a'], 2000);
  },
};
