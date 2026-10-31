import type { Shot } from '../types.js';

/** M21, M22 — a ready base draws a wave: warning, warp-in, assault. */
export const waveAttack: Shot = {
  id: 'wave-attack',
  section: 'mechanics',
  title: 'Wave attacks',
  caption: 'A finished base draws attention: the warning lands, a squad warps in, and the base fights back.',
  features: ['M21', 'M22', 'M30'],
  docs: ['wave-attacks', 'living-world'],
  reel: true,
  server: 'wave',
  // Joins anonymously AS the seeded base owner (the wave E2E's identity path).
  auth: false,
  storage: { eqxPlayerId: 'face0000-0000-4000-8000-000000000001' },
  target: { room: 'galaxy-wave-test', params: { spawnX: 0, spawnY: 600 } },
  hud: 'clean',
  async startWhen(ctx) {
    await ctx.page.locator('[data-testid="warp-warning"]').first().waitFor({ timeout: 90_000 });
  },
  durationMs: 16_000,
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 150, zoom: 0.55 } },
    { atMs: 7000, smoothMs: 1000, shot: { kind: 'frame', group: 'all', padding: 0.15, maxZoom: 0.9 } },
  ],
};
