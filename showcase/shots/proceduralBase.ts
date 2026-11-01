import type { Shot } from '../types.js';

/** Procedural bases — a deterministic, seeded warehouse; fly-over of its layout. */
export const proceduralBase: Shot = {
  id: 'procedural-base',
  section: 'tech',
  title: 'Procedural bases',
  caption: 'Bases are generated from a seed on every machine — identical layout, colliders and weapon cover, never sent over the wire.',
  features: ['T10', 'T9'],
  docs: ['procedural-bases'],
  reel: true,
  server: 'lean',
  // Spawn sits outside the south wall (room default). The base is 8000 u
  // across; keep within ~3000 u of the ship (interest window).
  target: { room: 'base-warehouse-showcase', params: { shipKind: 'scout' } },
  hud: 'none',
  durationMs: 12_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: 0, y: -3300, zoom: 0.9 },
          { t: 5000, x: 0, y: -2300, zoom: 0.45 },
          { t: 12000, x: 900, y: -1300, zoom: 0.3 },
        ],
      },
    },
  ],
};
