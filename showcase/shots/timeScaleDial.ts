import type { Shot, ShotContext } from '../types.js';
import { sendRoom } from './_helpers.js';
import { artSettled } from './capitals.js';

/** The pilot's room id (the dev endpoint addresses a sector by room). */
async function roomId(ctx: ShotContext): Promise<string | null> {
  return ctx.page.evaluate(() => {
    const c = (globalThis as { __eqxClient?: { room?: { roomId?: string } } }).__eqxClient;
    return c?.room?.roomId ?? null;
  }).catch(() => null);
}

/** Live NPC ships in the client's mirror. */
async function npcCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n;
  }).catch(() => 0);
}

/** Turn the sector's speed dial (it glides there, like a dimmer). */
async function dial(ctx: ShotContext, id: string, scale: number): Promise<void> {
  const res = await fetch(`${ctx.serverUrl}/dev/time-scale?room=${encodeURIComponent(id)}&scale=${scale}`, { method: 'POST' });
  ctx.log(`  [time-scale-dial] dial → ${scale}× (${res.status}), NPCs ${await npcCount(ctx)}`);
}

/**
 * Game speed (docs/features/game-speed.md). The fleet-fight scene: a drone
 * fleet and a robot fleet fight on sight in a sustained battle (the perf
 * scene, as it plays). The pilot watches in the SPECTATOR view (a held camera
 * is only allowed there; record as is), framed on the battle. The ONE thing
 * done by hand during the take is the feature itself: the sector's speed
 * dial is turned through the dev endpoint a demo would use (the caption says
 * so). It glides like a dimmer, 1× → 0.4× (slow motion: shots, beams,
 * explosions, shields and the AI all slow together) → 2× → 1×, and the HUD
 * chip shows each value.
 *
 * History (hostile reviews 2026-11-12): a fleet-melee version's fight ended
 * before 2× (empty 2× section); a pack-battle version's pilot died in ~2 s
 * and the spectator camera drifted off the fight. A sustained NPC battle
 * with a held spectator camera keeps the action on screen at every speed.
 */
export const timeScaleDial: Shot = {
  id: 'time-scale-dial',
  section: 'mechanics',
  title: 'Game speed',
  caption: 'Each sector has its own game speed. Here the dial is turned by hand mid-battle: the whole sector glides into slow motion (0.4×), then double speed (2×), then back to normal, and the HUD chip shows the speed whenever it isn\'t 1×.',
  features: ['M19'],
  docs: ['game-speed', 'game-time-scale'],
  reel: false,
  server: 'lean',
  target: { room: 'perf-fleet-fight', params: { shipKind: 'fighter' } },
  durationMs: 26_000,
  endsWithRun: true,
  async startWhen(ctx) {
    // The scene clock starts when the pilot is ready; wait for both fleets.
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n >= 40;
    }, undefined, { timeout: 60_000, polling: 250 });
    await ctx.spectate();
    const k = ctx.viewport.width / 1920;
    await ctx.cinema.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: 0, y: 1200, zoom: 0.45 * k } }]);
    // Let the fleets close and open fire before the take rolls.
    await ctx.sleep(2500);
    ctx.log(`  [time-scale-dial] NPCs at take start: ${await npcCount(ctx)}`);
  },
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-dial: no room id on the client');
    await ctx.sleep(2000);
    await dial(ctx, id, 0.4); // glides down in ~1.2 s
    await ctx.sleep(6200); // ~5 s of slow motion
    await dial(ctx, id, 2); // glides up in ~3.2 s
    await ctx.sleep(8200); // ~5 s at 2×
    await dial(ctx, id, 1); // back to normal in ~2 s
    await ctx.sleep(4000);
  },
};

/**
 * Game speed with capitals (owner 2026-11-12: "a couple more clips just to
 * prove the point. Capitals fighting for example"). The capital-broadside
 * fight as it plays: five capitals (destroyer to battleship) turn their
 * batteries on the pilot's heavy cruiser once their art has baked (the same
 * room, params and `test_aggro` cue as capital-broadside), watched from the
 * spectator view framed on the whole group. The dial is turned by hand, the
 * feature being filmed: 1× → 0.4× (shells crawl, turrets slew slowly) → 2×
 * (salvos come fast) → 1×.
 */
export const timeScaleCapitals: Shot = {
  id: 'time-scale-capitals',
  section: 'mechanics',
  title: 'Game speed: capitals',
  caption: 'The same speed dial on a capital-ship battle: main batteries, secondaries and anti-aircraft fire glide into slow motion (0.4×), then double speed (2×), then back to normal.',
  features: ['CAP', 'M19'],
  docs: ['game-speed'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals-combat', params: { sectorScale: '4', shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  durationMs: 30_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.spectate();
    // The fight starts as the last setup step (as capital-broadside), and the
    // batteries get a moment to train before the take rolls.
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    await ctx.sleep(4000);
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.2, maxZoom: 2.5 } }],
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-capitals: no room id on the client');
    await ctx.sleep(3000);
    await dial(ctx, id, 0.4); // ~1.2 s glide
    await ctx.sleep(7200); // ~6 s of slow motion
    await dial(ctx, id, 2); // ~3.2 s glide
    await ctx.sleep(10_200); // ~7 s at 2×
    await dial(ctx, id, 1); // ~2 s glide
    await ctx.sleep(4000);
  },
};
