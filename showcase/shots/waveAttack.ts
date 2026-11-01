import type { Shot } from '../types.js';

/** M21, M22 — a ready base draws a wave: warning, warp-in, assault. */
export const waveAttack: Shot = {
  id: 'wave-attack',
  section: 'mechanics',
  title: 'Wave attacks',
  caption: 'A finished base draws attention: the warning lands, a squad warps in, and the base fights back.',
  features: ['M21', 'M22', 'M30'],
  docs: ['wave-attacks', 'living-world'],
  // Catalogue-only for now: the squad lands at the sector edge and holds there
  // for > 45 s before committing (rally / approach timing), so the assault does
  // not reliably land inside a take. Needs a fast-approach testMode trigger.
  reel: false,
  server: 'wave',
  // Joins anonymously AS the seeded base owner (the wave E2E's identity path).
  auth: false,
  storage: { eqxPlayerId: 'face0000-0000-4000-8000-000000000001' },
  target: { room: 'galaxy-wave-test', params: { spawnX: 0, spawnY: 600 } },
  hud: 'clean',
  // Start on whichever comes first: the incoming-wave warning, or the squad
  // landing (the swarm count jumps by most of a squad above the room's own
  // parked drone + asteroids — the baseline captured before waiting).
  async startWhen(ctx) {
    const read = (): Promise<number> =>
      ctx.page.evaluate(
        () =>
          (window as unknown as { __eqxStore?: { getState(): { swarmCount: number } } }).__eqxStore?.getState()
            .swarmCount ?? 0,
      );
    const baseline = await read();
    await ctx.page.waitForFunction(
      (base) => {
        const s = (window as unknown as { __eqxStore?: { getState(): { warpWarnings: unknown[]; swarmCount: number } } })
          .__eqxStore?.getState();
        return !!s && (s.warpWarnings.length > 0 || s.swarmCount >= base + 4);
      },
      baseline,
      { timeout: 120_000, polling: 250 },
    );
  },
  // The squad lands at the sector edge and flies in: frame base + squad
  // together (the frame tightens as they close), and cut the long approach.
  durationMs: 45_000,
  cuts: [{ fromMs: 7000, toMs: 27_000, label: 'approach' }],
  camera: [{ atMs: 0, smoothMs: 1500, shot: { kind: 'frame', group: 'all', padding: 0.12, maxZoom: 0.9 } }],
};
