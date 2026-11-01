import type { Shot } from '../types.js';

/** Procedural bases — an NPC refinery settlement grown from a seed by the
 *  production-chain generator (plan soft-leaping-truffle v3, D2), out of real
 *  structures: Capital, power, processors, storage, a fenced perimeter with
 *  gates. Fly-over from the spawn south of the fence. */
export const proceduralBase: Shot = {
  id: 'procedural-base',
  section: 'tech',
  title: 'Procedural bases',
  caption: 'NPC bases grow from a seed out of real structures: power, refineries, storage and a shield fence that all work like yours.',
  features: ['T10', 'T9'],
  docs: ['procedural-bases', 'structure-network-scale'],
  reel: true,
  server: 'lean',
  // The pilot spawns south of the fence (room default 0, -3600).
  target: { room: 'npc-base-settlement', params: { shipKind: 'scout' } },
  hud: 'none',
  durationMs: 12_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: 0, y: -3300, zoom: 0.8 },
          { t: 5000, x: 0, y: -1800, zoom: 0.35 },
          { t: 12000, x: 0, y: 0, zoom: 0.18 },
        ],
      },
    },
  ],
};
