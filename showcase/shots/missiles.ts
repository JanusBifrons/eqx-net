import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** M11, M15 — homing missiles curving onto targets, detonation effects. */
export const missiles: Shot = {
  id: 'missiles',
  section: 'mechanics',
  title: 'Heat-seekers',
  caption: 'The missile frigate launches homing salvos that curve onto their targets.',
  features: ['M11', 'M15'],
  docs: ['missiles', 'missile-simulation'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test', params: { shipKind: 'missile-frigate', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 11_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.3, maxZoom: 1.1 } },
    { atMs: 6500, smoothMs: 700, shot: { kind: 'track', target: 'local', zoom: 1.0 } },
  ],
};
