import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** Loot & cargo — a kill drops a pod; flying over it fills the hold. */
export const loot: Shot = {
  id: 'loot',
  section: 'mechanics',
  title: 'Loot & cargo',
  caption: 'Every kill drops a loot pod — fly over it to haul the salvage and credits home, or lose it if you die.',
  features: ['M17'],
  docs: ['loot-and-cargo'],
  reel: true,
  server: 'lean',
  // Pickup needs a roster row, so a roster-backed room (engineering rooms have
  // none). Its heavy is peaceful + hull-exposed: auto-fire kills it fast, then
  // the ship flies through the pod it drops.
  target: { room: 'showcase-levelup', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'clean',
  durationMs: 10_000,
  camera: [{ atMs: 0, smoothMs: 250, shot: { kind: 'track', target: 'local', zoom: 1.8, offsetY: 80 } }],
  async run(ctx) {
    await ctx.sleep(3500);
    await ctx.hold(['w'], 1300);
  },
};
