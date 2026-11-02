import type { Shot } from '../types.js';

/**
 * Shield Gates (plan soft-leaping-truffle v2, phase V) — `gate-test` room: two
 * powered gates on y = −900. The west one (x −400) admits anyone not hostile,
 * the east one (x 400) is owner-only and locked to a visiting pilot. The pilot
 * spawns south of the west gate and boosts straight through it as it opens.
 */
export const shieldGates: Shot = {
  id: 'shield-gates',
  section: 'mechanics',
  title: 'Shield gates',
  caption: 'Shield gates open as a friendly ship approaches and stay shut to anyone their owner has not let in.',
  features: ['M32'],
  docs: ['shield-gates'],
  reel: true,
  server: 'lean',
  target: { room: 'gate-test', params: { shipKind: 'fighter', spawnX: -400, spawnY: -1300 } },
  hud: 'minimal',
  durationMs: 9_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: -400, y: -1020, zoom: 1.25 } },
    { atMs: 5200, smoothMs: 900, shot: { kind: 'track', target: 'local', zoom: 1.1, leadMs: 200 } },
  ],
  async run(ctx) {
    await ctx.sleep(1000);
    await ctx.hold(['w'], 2600);
    await ctx.hold(['s'], 1200);
  },
};
