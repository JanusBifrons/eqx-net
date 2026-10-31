import type { Shot } from '../types.js';

/** M1–M3, M18 — Newtonian flight, facing boost, particle exhaust, energy drain. */
export const flight: Shot = {
  id: 'flight',
  section: 'mechanics',
  title: 'Flight',
  caption: 'Momentum-based handling with a facing-direction boost — every thrust shows in the particle exhaust.',
  features: ['M1', 'M2', 'M3', 'M18'],
  docs: ['ship-physics-handling', 'auto-fire-and-boost'],
  reel: true,
  server: 'lean',
  target: { room: 'test-sector', params: { shipKind: 'fighter' } },
  hud: 'minimal',
  durationMs: 12_000,
  camera: [{ atMs: 0, smoothMs: 300, shot: { kind: 'track', target: 'local', zoom: 2.0, leadMs: 250 } }],
  async run(ctx) {
    await ctx.hold(['w'], 2000);
    await ctx.hold(['w', 'a'], 1400);
    await ctx.hold(['w', 'ShiftLeft'], 2200);
    await ctx.hold(['d'], 900);
    await ctx.hold(['ShiftLeft'], 1600);
    await ctx.hold(['w', 'd'], 1600);
  },
};
