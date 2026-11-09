import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/** M9, M12–M14, U6 — auto-fire beams, shield break, hull damage numbers. */
export const beamCombat: Shot = {
  id: 'beam-combat',
  section: 'mechanics',
  title: 'Shields, then hull',
  caption: 'AUTO weapon groups lock onto hostiles, then fire. Beams taper with range; shields must fall before the hull takes damage.',
  features: ['M9', 'M12', 'M13', 'M14', 'U6'],
  // Lock-to-fire is universal (2026-11-09): this take films the AUTO lock + fire.
  docs: ['shield-hull', 'auto-fire-and-boost', 'fire-control', 'weapon-groups-and-locking'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'minimal',
  durationMs: 11_000,
  camera: [{ atMs: 0, smoothMs: 250, shot: { kind: 'track', target: 'local', zoom: 1.45 } }],
  async run(ctx) {
    await ctx.sleep(3000);
    await ctx.hold(['a'], 900);
    await ctx.hold(['w'], 800);
  },
};
