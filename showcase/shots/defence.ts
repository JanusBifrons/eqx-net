import type { Shot } from '../types.js';
import { AS_PILOT, SURVIVE } from './_helpers.js';

/** M29, M31, M32 — shield-pylon wall, bolt + missile turrets, battery-backed power. */
export const defence: Shot = {
  id: 'defence',
  section: 'mechanics',
  title: 'Defences',
  caption: 'Pylons raise a shield wall that soaks fire from grid power and batteries while turrets return it.',
  features: ['M29', 'M31', 'M32'],
  docs: ['shield-fence', 'structures-and-power-grid'],
  reel: true,
  server: 'lean',
  ...AS_PILOT,
  target: { room: 'showcase-defence', params: { shipKind: 'heavy', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 14_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: -520, zoom: 0.72 } },
    { atMs: 6000, smoothMs: 1200, shot: { kind: 'hold', x: 0, y: -440, zoom: 1.45 } },
  ],
};
