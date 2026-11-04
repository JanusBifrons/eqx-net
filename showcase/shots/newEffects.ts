import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** New effects and backdrop (plan iridescent-seeking-rainbow v3): the pack
 *  battle with beam glow, bolt trails, fireballs, shield ripples, a sector
 *  nebula and the baked starfield. The capture browser is automated, so the
 *  shot asks for the look explicitly. */
export const newEffects: Shot = {
  id: 'new-effects',
  section: 'mechanics',
  title: 'Weapons and space, made once',
  caption: 'Beams, bolts, fireballs, shield ripples, nebulae and stars are generated once at load and drawn as cheap batched sprites.',
  features: ['ART'],
  docs: ['art-direction'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test-25', params: { shipKind: 'interceptor', art: 'machined', fx: 'new', ...SURVIVE } },
  hud: 'none',
  durationMs: 12_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.2, maxZoom: 0.8 } },
    { atMs: 5000, smoothMs: 900, shot: { kind: 'track', target: 'local', zoom: 1.4, leadMs: 300 } },
  ],
  async run(ctx) {
    await ctx.hold(['w'], 1500);
    await ctx.hold(['w', 'a'], 2500);
    await ctx.hold(['w', 'ShiftLeft'], 1500);
  },
};
