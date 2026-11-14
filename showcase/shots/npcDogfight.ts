import type { Shot, ShotContext } from '../types.js';

/** Live NPC ships in the spectator's mirror. */
async function npcCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n;
  }).catch(() => 0);
}

async function sideCounts(ctx: ShotContext): Promise<{ robots: number; drones: number }> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    let robots = 0; let drones = 0;
    m?.swarm.forEach((e) => { if (e.kind !== 1) return; if (e.shipKind?.startsWith('robot')) robots++; else drones++; });
    return { robots, drones };
  }).catch(() => ({ robots: 0, drones: 0 }));
}

/**
 * A small NPC dogfight: three drone fighters against three robots (sides that
 * fight on sight), filmed from spectator mode with a held camera over the
 * fight. No cues during the take; it ends ~3 s after one side is gone.
 */
export const npcDogfight: Shot = {
  id: 'npc-dogfight',
  section: 'mechanics',
  title: 'NPC dogfight (3v3)',
  caption: 'Three drone fighters meet three robots. Nobody is steering them: they chase, turn and break on their own.',
  features: ['M19'],
  docs: [],
  reel: false,
  server: 'lean',
  target: { room: 'perf-dogfight-3v3', params: { shipKind: 'fighter' } },
  durationMs: 30_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n >= 6;
    }, undefined, { timeout: 60_000, polling: 250 });
    await ctx.spectate();
    const k = ctx.viewport.width / 1920;
    await ctx.cinema.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 0, zoom: 0.9 * k } }]);
    ctx.log(`  [npc-dogfight] NPCs at take start: ${await npcCount(ctx)}`);
  },
  async run(ctx) {
    const t0 = Date.now();
    const left = (): number => 29_000 - (Date.now() - t0);
    let last = '';
    while (left() > 0) {
      const c = await sideCounts(ctx);
      const s = `drones=${c.drones} robots=${c.robots}`;
      if (s !== last) { ctx.log(`  [npc-dogfight] t=${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`); last = s; }
      if (c.robots === 0 || c.drones === 0) break;
      await ctx.sleep(500);
    }
    if (left() > 0) await ctx.sleep(Math.min(3000, left()));
  },
};
