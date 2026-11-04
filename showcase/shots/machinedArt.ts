import type { Shot } from '../types.js';

/** Machined art (plan iridescent-seeking-rainbow): the lit, panelled look on
 *  the same line-up as the ship gallery, so the two read side by side. The
 *  capture browser is automated, so the shot asks for the look explicitly. */
export const machinedArt: Shot = {
  id: 'machined-art',
  section: 'mechanics',
  title: 'Machined',
  caption: 'Every hull and structure is lit by the sector’s sun: bevelled plating, panel seams and specular glints, generated from each ship’s own shape.',
  features: ['ART'],
  docs: ['art-direction'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-ship-gallery', params: { shipKind: 'fighter', art: 'machined' } },
  hud: 'none',
  durationMs: 11_000,
  camera: [
    {
      atMs: 0,
      smoothMs: 0,
      shot: {
        kind: 'path',
        keys: [
          { t: 0, x: -900, y: 350, zoom: 3 },
          { t: 9000, x: 900, y: 350, zoom: 3 },
          { t: 11000, x: 0, y: 300, zoom: 0.9 },
        ],
      },
    },
  ],
};
