import type { Shot } from '../types.js';
import { sendRoom } from './_helpers.js';

/** The scrap piece nearest (x, y): its swarm entity id, or null. */
async function scrapNear(ctx: Parameters<NonNullable<Shot['run']>>[0], x: number, y: number): Promise<number | null> {
  return ctx.page.evaluate(([px, py]) => {
    const swarm = (window as unknown as {
      __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; x: number; y: number }> } };
    }).__eqxClient?.mirror?.swarm;
    let best: number | null = null, bestD = Infinity;
    for (const [id, e] of swarm ?? []) {
      if (e.kind !== 3) continue; // scrap
      const d = Math.hypot(e.x - px!, e.y - py!);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }, [x, y] as const);
}

/**
 * Salvage plan PR 11b — the tractor beam on screen: a pale-blue glowing
 * beam from the barrel tip to a held scrap piece (look A). Catalogue shot:
 * the `test_tractor` cue lends the interceptor's nose mount a tractor; the
 * barge itself is filmed by `barge-mining`.
 */
export const tractorBeam: Shot = {
  id: 'tractor-beam',
  section: 'mechanics',
  title: 'Tractor beam',
  caption: 'A tractor beam holds a piece of scrap: a pale-blue glowing beam from the barrel tip.',
  features: ['SALVAGE'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'lean',
  target: { room: 'scrap-stress-test', params: { shipKind: 'interceptor' } },
  hud: 'minimal',
  durationMs: 8_000,
  // The game's follow camera; the pilot zooms in with the mouse wheel.
  async prepare(ctx) {
    await ctx.page.mouse.move(960, 540);
    for (let i = 0; i < 8; i++) { await ctx.page.mouse.wheel(0, -100); await ctx.sleep(120); }
    await ctx.sleep(600);
  },
  async run(ctx) {
    // Off to the right in the scrap field (rows start 250 u ahead of spawn).
    const id = await scrapNear(ctx, 144, 490);
    if (id === null) throw new Error('tractor-beam: no scrap in the mirror');
    await sendRoom(ctx, 'test_tractor', { type: 'test_tractor', target: id, ticks: 3600 });
    await ctx.sleep(7_500);
  },
};
