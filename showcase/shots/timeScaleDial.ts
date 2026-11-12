import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';

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
 * pack-battle fight: a 25-drone pack turns on the pilot (one `test_aggro` as
 * the last setup step, as pack-battle does), the follow camera on the pilot,
 * real hull and lock times. The ONE thing done by hand during the take is the
 * feature itself: the sector's speed dial is turned through the dev endpoint
 * a demo would use (the caption says so). It glides like a dimmer, 1× → 0.4×
 * (slow motion: shots, beams, explosions, shields and the AI all slow
 * together) → 2× → 1×, and the HUD chip shows each value. If the pilot dies,
 * the take keeps rolling in the spectator view the game switches to.
 *
 * (A first version used fleet-melee: its fight is over in ~8 game seconds,
 * so the 2× part filmed an empty scene; hostile review 2026-11-12.)
 */
export const timeScaleDial: Shot = {
  id: 'time-scale-dial',
  section: 'mechanics',
  title: 'Game speed',
  caption: 'Each sector has its own game speed. Here the dial is turned by hand mid-fight: the whole sector glides into slow motion (0.4×), then double speed (2×), then back to normal, and the HUD chip shows the speed whenever it isn\'t 1×.',
  features: ['M15', 'M19'],
  docs: ['game-speed', 'game-time-scale'],
  reel: false,
  server: 'lean',
  target: { room: 'feel-test-25', params: { shipKind: 'interceptor' } },
  durationMs: 26_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
  },
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-dial: no room id on the client');
    let flying = true;
    // The dial, on its own wall-clock timeline, alongside the flight.
    const dialing = (async () => {
      await ctx.sleep(2000);
      await dial(ctx, id, 0.4); // glides down in ~1.2 s
      await ctx.sleep(6200); // ~5 s of slow motion
      await dial(ctx, id, 2); // glides up in ~3.2 s
      await ctx.sleep(8200); // ~5 s at 2×
      await dial(ctx, id, 1); // back to normal in ~2 s
      await ctx.sleep(4000);
      flying = false;
    })();
    // The pilot flies a steady weave through the pack (as pack-battle).
    const weaving = (async () => {
      while (flying) {
        await ctx.hold(['w'], 1500);
        if (!flying) break;
        await ctx.hold(['w', 'a'], 2500);
        if (!flying) break;
        await ctx.hold(['w', 'd'], 2500);
      }
    })();
    await Promise.all([dialing, weaving]);
  },
};
