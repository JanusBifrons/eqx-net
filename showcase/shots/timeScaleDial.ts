import type { Shot, ShotContext } from '../types.js';
import { flyTo, face } from './_pilot.js';
import { nearestRobot, npcCount, piloting, robotCount } from './fleetMelee.js';

/** The pilot's room id (the dev endpoint addresses a sector by room). */
async function roomId(ctx: ShotContext): Promise<string | null> {
  return ctx.page.evaluate(() => {
    const c = (globalThis as { __eqxClient?: { room?: { roomId?: string } } }).__eqxClient;
    return c?.room?.roomId ?? null;
  }).catch(() => null);
}

/** Turn the sector's speed dial (it glides there, like a dimmer). */
async function dial(ctx: ShotContext, id: string, scale: number): Promise<void> {
  const res = await fetch(`${ctx.serverUrl}/dev/time-scale?room=${encodeURIComponent(id)}&scale=${scale}`, { method: 'POST' });
  ctx.log(`  [time-scale-dial] dial → ${scale}× (${res.status})`);
}

/**
 * Game speed (docs/features/game-speed.md), filmed as a player sees it. The
 * same live drone-versus-robot fight as fleet-melee, with the fighter flying
 * in after the robots exactly as there. The ONE thing done by hand is the
 * feature itself: the sector's speed dial is turned during the take through
 * the dev endpoint a demo would use, so this is the dial, not staging (the
 * caption says so). Everything glides like a dimmer: 1× → 0.4× (slow motion:
 * shots, beams, explosions, shields and the AI all slow together) → 2× → 1×.
 * The HUD speed chip (amber when slow, cyan when fast) shows each value.
 */
export const timeScaleDial: Shot = {
  id: 'time-scale-dial',
  section: 'mechanics',
  title: 'Game speed',
  caption: 'Each sector has its own game speed. Here the dial is turned by hand mid-fight: the whole sector glides into slow motion (0.4×), then double speed (2×), then back to normal, and the HUD chip shows the speed whenever it isn\'t 1×.',
  features: ['M19'],
  docs: ['game-speed', 'game-time-scale'],
  reel: false,
  server: 'lean',
  target: { room: 'showcase-melee', params: { shipKind: 'fighter' } },
  durationMs: 40_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n >= 12;
    }, undefined, { timeout: 60_000, polling: 250 });
    await ctx.sleep(1000);
    ctx.log(`  [time-scale-dial] NPCs at take start: ${await npcCount(ctx)}`);
  },
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-dial: no room id on the client');
    const t0 = Date.now();
    const left = (): number => 38_000 - (Date.now() - t0);
    // The dial, on its own timeline (wall seconds), alongside the flight.
    const dialing = (async () => {
      await ctx.sleep(3000);
      await dial(ctx, id, 0.4); // glides down in ~1.2 s
      await ctx.sleep(9000); // slow motion
      await dial(ctx, id, 2); // glides up in ~3.2 s
      await ctx.sleep(8000);
      await dial(ctx, id, 1); // back to normal in ~2 s
      await ctx.sleep(4000);
    })();
    // The fighter goes after the robots, as in fleet-melee.
    const flying = (async () => {
      while (left() > 1000 && (await piloting(ctx))) {
        const r = await nearestRobot(ctx);
        if (!r) break;
        await flyTo(ctx, r.x, r.y, { arrive: 220, maxMs: Math.min(3000, left()), cruise: 260, passThrough: true });
        const r2 = await nearestRobot(ctx);
        if (r2 && left() > 1000) await face(ctx, r2.x, r2.y, 700);
      }
    })();
    await Promise.all([dialing, flying]);
    ctx.log(`  [time-scale-dial] end piloting=${await piloting(ctx)} robots=${await robotCount(ctx)} NPCs=${await npcCount(ctx)}`);
  },
};
