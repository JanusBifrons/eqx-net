import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** M7, M19 — multi-mount turrets slewing independently onto targets. */
export const turrets: Shot = {
  id: 'turrets',
  section: 'mechanics',
  title: 'Independent turrets',
  caption: 'Every mount tracks its own target within its firing arc — server-authoritative, predicted locally.',
  features: ['M7', 'M19'],
  docs: ['weapon-mounts', 'multi-turret-ships'],
  reel: true,
  server: 'lean',
  target: { room: 'mount-test', params: { shipKind: 'gunship', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 10_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.35, maxZoom: 1.6 } }],
  async run(ctx) {
    await ctx.hold(['a'], 1500);
    await ctx.hold(['w'], 900);
  },
};
