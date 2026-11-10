import type { Shot } from '../types.js';

/**
 * Off-screen radar (edge-track redesign, #173) — `radar-sandbox` room: ships,
 * structures and asteroids parked at known offsets around the spawn. As the
 * pilot turns and flies, each off-screen contact's marker slides along the
 * screen edge toward it.
 */
export const radar: Shot = {
  id: 'radar',
  section: 'mechanics',
  title: 'Edge radar',
  caption: 'Everything off screen is tracked on the screen edge, so you always know where the fight and your base are.',
  features: ['U6'],
  docs: ['off-screen-indicators'],
  reel: true,
  server: 'lean',
  // `radar=1`: keep the edge radar under `hud: 'minimal'` (it is hidden below
  // the full HUD otherwise, cinematic/hudMode.ts `radarVisible`).
  target: { room: 'radar-sandbox', params: { shipKind: 'interceptor', radar: '1' } },
  hud: 'minimal',
  durationMs: 11_000,
  camera: [{ atMs: 0, smoothMs: 300, shot: { kind: 'track', target: 'local', zoom: 1.4, leadMs: 200 } }],
  async run(ctx) {
    await ctx.sleep(1200);
    await ctx.hold(['a'], 1600);
    await ctx.hold(['w'], 2000);
    await ctx.hold(['w', 'd'], 2200);
    await ctx.hold(['ShiftLeft'], 1600);
    await ctx.hold(['a'], 1200);
  },
};
