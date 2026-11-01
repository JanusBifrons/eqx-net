import type { Shot } from '../types.js';

/** M4 — the six player hulls, dollied along the line-up. */
export const shipGallery: Shot = {
  id: 'ship-gallery',
  section: 'mechanics',
  title: 'Six hulls',
  caption: 'Scout, fighter, interceptor, heavy, gunship and missile frigate — each with its own handling and loadout.',
  features: ['M4', 'M7'],
  docs: ['ship-kinds', 'multi-turret-ships', 'weapon-mounts'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-ship-gallery', params: { shipKind: 'fighter' } },
  hud: 'none',
  durationMs: 11_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: -900, y: 350, zoom: 2.4 },
          { t: 9000, x: 900, y: 350, zoom: 2.4 },
          { t: 11000, x: 0, y: 300, zoom: 0.75 },
        ],
      },
    },
  ],
};
