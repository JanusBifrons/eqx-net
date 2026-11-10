import type { Shot } from '../types.js';

/** M14, M15, M19, T3, T4 — a 25-drone pack engages: AI, explosions, shockwaves.
 *  Filmed as a player sees it (2026-11-10): the follow camera on the pilot,
 *  the pilot's real hull and the real lock times (no survive / instant-lock
 *  cues). `startHostile` only sets the scene: the pack is hostile at join. */
export const packBattle: Shot = {
  id: 'pack-battle',
  section: 'mechanics',
  title: 'The pack',
  caption: 'Drone AI picks targets by weapon range and weakness — and dies loudly.',
  features: ['M15', 'M19', 'M14', 'T3', 'T4'],
  docs: ['drone-snapshot-interpolation', 'visual-effects', 'ai-lockstep'],
  reel: true,
  server: 'lean',
  target: { room: 'feel-test-25', params: { shipKind: 'interceptor', startHostile: 1 } },
  hud: 'minimal',
  durationMs: 12_000,
  async run(ctx) {
    await ctx.hold(['w'], 1500);
    await ctx.hold(['w', 'a'], 2500);
    await ctx.hold(['w', 'ShiftLeft'], 1500);
  },
};
