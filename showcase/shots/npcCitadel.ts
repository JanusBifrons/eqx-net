import type { Shot } from '../types.js';

/**
 * NPC bases at scale (D1/D2/T1, plan soft-leaping-truffle v3) — the largest
 * tier the production-chain generator grows: a citadel. A slow descent from
 * the spawn south of it into its core.
 */
export const npcCitadel: Shot = {
  id: 'npc-citadel',
  section: 'mechanics',
  title: 'NPC citadels',
  caption: 'Every galaxy sector grows its own NPC bases, from outposts to sprawling citadels like this one.',
  features: ['T10'],
  docs: [],
  reel: true,
  server: 'lean',
  target: { room: 'npc-base-citadel', params: { shipKind: 'scout' } },
  hud: 'none',
  durationMs: 14_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: 0, y: -4400, zoom: 0.4 },
          { t: 6000, x: 0, y: -2600, zoom: 0.3 },
          { t: 14000, x: 0, y: -600, zoom: 0.21 },
        ],
      },
    },
  ],
};
