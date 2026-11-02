import type { Shot } from '../types.js';

/** Cities (plan soft-leaping-truffle v3, D3) — an NPC colony: housing and
 *  residential towers that use up provisions and consumer goods (the chain's
 *  end products) and pay taxes, fed by its own hydroponics and by convoys.
 *  Fly-over from the spawn south of the fence. */
export const colonyCity: Shot = {
  id: 'colony-city',
  section: 'mechanics',
  title: 'Cities',
  caption: 'Cities consume what the chain makes: their residents use provisions and consumer goods and pay taxes.',
  features: ['T10'],
  docs: [],
  reel: false,
  server: 'lean',
  // The pilot spawns south of the fence (room default 0, -3600).
  target: { room: 'npc-base-colony', params: { shipKind: 'scout' } },
  hud: 'none',
  durationMs: 10_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: 0, y: -3200, zoom: 0.7 },
          { t: 5000, x: 0, y: -1500, zoom: 0.35 },
          { t: 10000, x: 0, y: 0, zoom: 0.22 },
        ],
      },
    },
  ],
};
