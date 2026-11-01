import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** Robots — a mixed-tier robot squad fights a drone pack (and the pilot). */
export const robots: Shot = {
  id: 'robots',
  section: 'mechanics',
  title: 'Rival factions',
  caption: 'Robot squads — hexagon leads, circles and cubes — fight the drones and anyone else in reach, and drop tiered loot.',
  features: ['M19'],
  docs: ['robots'],
  reel: true,
  server: 'lean',
  // `robots-showcase` (added with the robots feature): six drones west, a
  // mixed-tier robot squad east, the pilot between them.
  target: { room: 'robots-showcase', params: { shipKind: 'heavy', spawnX: 0, spawnY: 120, ...SURVIVE } },
  hud: 'minimal',
  durationMs: 12_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 480, zoom: 0.95 } },
    { atMs: 6000, smoothMs: 1200, shot: { kind: 'frame', group: 'drones', padding: 0.2, maxZoom: 1.2 } },
  ],
};
