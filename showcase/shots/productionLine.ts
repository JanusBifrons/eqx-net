import type { Shot } from '../types.js';

/** Production chains + the Mine Layer — an NPC manufactory stronghold grown by
 *  the production-chain generator: processors pulling from shared storage, the
 *  grid web flowing toward the Freight Dock, and a minefield ringing its
 *  approach (plan soft-leaping-truffle v3). Low pass from the spawn south of
 *  the fence, over the field and into the industrial core. */
export const productionLine: Shot = {
  id: 'production-line',
  section: 'mechanics',
  title: 'Production chains',
  caption: 'Bases refine raw ore into parts and products, trade the surplus by convoy, and mine their own approaches.',
  features: ['T10'],
  docs: ['production-chains', 'mine-layer'],
  reel: true,
  server: 'lean',
  // The pilot spawns south of the fence (room default 0, -4400).
  target: { room: 'npc-base-stronghold', params: { shipKind: 'scout' } },
  hud: 'none',
  durationMs: 14_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: 0, y: -4000, zoom: 0.55 },
          { t: 5000, x: 0, y: -2600, zoom: 0.4 },
          { t: 10000, x: 0, y: -900, zoom: 0.28 },
          { t: 14000, x: 0, y: 0, zoom: 0.2 },
        ],
      },
    },
  ],
};
