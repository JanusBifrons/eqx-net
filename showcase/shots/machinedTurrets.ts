import type { Shot } from '../types.js';
import { SURVIVE } from './_helpers.js';

/**
 * Machined turrets (turret rollout T1–T3, 2026-11-05): a gunship's two
 * turrets, each sitting in a ring cut into its hull, track and fire at a
 * ring of drones. Each bolt kicks its barrel back with a flash at the tip and
 * leaves from that tip. Same room and camera as the `turrets` shot (mount-test,
 * framed on the fight), here in the Machined look; the capture browser is
 * automated, so the shot asks for the new look explicitly.
 */
export const machinedTurrets: Shot = {
  id: 'machined-turrets',
  section: 'mechanics',
  title: 'Machined turrets',
  caption: 'Turrets built into the hull, turning to track, kicking back and flashing as they fire, with every shot leaving the barrel tip.',
  features: ['ART'],
  docs: ['art-direction'],
  reel: true,
  server: 'lean',
  target: {
    room: 'mount-test',
    params: { shipKind: 'gunship', art: 'machined', fx: 'new', ...SURVIVE },
  },
  hud: 'none',
  durationMs: 10_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0.3, maxZoom: 2.6 } }],
  async run(ctx) {
    await ctx.hold(['a'], 1500);
    await ctx.hold([], 1500);
    await ctx.hold(['w'], 900);
  },
};
