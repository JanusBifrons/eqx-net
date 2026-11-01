import type { Shot } from '../types.js';

/** T1, T5 — thousands of server entities, interest-culled binary snapshots. */
export const scale: Shot = {
  id: 'scale',
  section: 'tech',
  title: 'Scale',
  caption: 'Hundreds of physics bodies, simulated on the server and streamed to each client in a compact binary format — only what is near it.',
  features: ['T5', 'T1'],
  docs: ['snapshot-cadence', 'generic-entity-pipeline', 'sector-room-anatomy'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-swarm', params: { shipKind: 'scout', initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 11_000,
  // Pull back to 0.3 — the whole field sits inside the ~±3000 u interest window.
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: { kind: 'path', keys: [{ t: 0, x: 0, y: 0, zoom: 1.0 }, { t: 9000, x: 0, y: 0, zoom: 0.3 }] },
    },
  ],
};
