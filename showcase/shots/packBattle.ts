import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** M14, M15, M19, T3, T4 — a 25-drone pack engages: AI, explosions, shockwaves. */
export const packBattle: Shot = {
  id: 'pack-battle',
  section: 'mechanics',
  title: 'The pack',
  caption: 'Drone AI picks targets by weapon range and weakness — and dies loudly.',
  features: ['M15', 'M19', 'M14', 'T3', 'T4'],
  docs: ['drone-snapshot-interpolation', 'visual-effects', 'ai-lockstep'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test-25', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 12_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.15, maxZoom: 0.9 } },
    { atMs: 6000, smoothMs: 900, shot: { kind: 'track', target: 'local', zoom: 1.2, leadMs: 300 } },
  ],
  async run(ctx) {
    await ctx.hold(['w'], 1500);
    await ctx.hold(['w', 'a'], 2500);
    await ctx.hold(['w', 'ShiftLeft'], 1500);
  },
};
