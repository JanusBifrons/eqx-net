import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** Robot nexus — the heart of robot territory, under attack. */
export const nexus: Shot = {
  id: 'nexus',
  section: 'mechanics',
  title: 'Robot territory',
  caption: 'A robot nexus anchors their territory: reinforcements spawn at it, and its sector turns robot-violet on the galaxy map.',
  features: ['M19'],
  docs: ['robot-territory'],
  reel: true,
  server: 'lean',
  // `nexus-showcase` (added with P3): the nexus + robot guard north, a drone
  // pack drifting in from the west, the pilot just south of the guard.
  target: { room: 'nexus-showcase', params: { shipKind: 'heavy', spawnX: 0, spawnY: 320, ...SURVIVE } },
  hud: 'minimal',
  durationMs: 12_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 560, zoom: 0.8 } },
    { atMs: 6000, smoothMs: 1500, shot: { kind: 'hold', x: -200, y: 450, zoom: 0.6 } },
  ],
};
