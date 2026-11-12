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

/** The battleship's camera id (`swarm-<entityId>`), or null. */
async function battleshipId(ctx: ShotContext): Promise<string | null> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    let found: string | null = null;
    m?.swarm.forEach((e, eid) => { if (found === null && e.kind === 1 && e.shipKind === 'battleship') found = `swarm-${eid}`; });
    return found;
  }).catch(() => null);
}

/**
 * The pilot locks the battleship with every weapon group, as a player does
 * from the contacts list (the client's own `requestLock`). A live player lock
 * keeps an NPC hostile (owner rule 2026-11-10), so the capitals keep fighting
 * at any speed instead of forgetting the aggro after 30 GAME seconds (which at
 * 4× is 7.5 s of wall time).
 */
async function lockBattleship(ctx: ShotContext, camId: string): Promise<number> {
  const eid = Number(camId.replace('swarm-', ''));
  return ctx.page.evaluate((entityId) => {
    const g = globalThis as { __eqxClient?: { requestLock(groupId: string, key: string): void }; __eqxStore?: { getState(): { fcGroups?: Array<{ id: string }> } } };
    const groups = g.__eqxStore?.getState().fcGroups ?? [];
    for (const grp of groups) g.__eqxClient?.requestLock(grp.id, `s:${entityId}`);
    return groups.length;
  }, eid).catch(() => 0);
}

/** Set the speed at once (setup only, before the take rolls). */
async function snapSpeed(ctx: ShotContext, id: string, scale: number): Promise<void> {
  const res = await fetch(`${ctx.serverUrl}/dev/time-scale?room=${encodeURIComponent(id)}&scale=${scale}&snap=1`, { method: 'POST' });
  ctx.log(`  [time-scale] speed set to ${scale}× before the take (${res.status})`);
}

/**
 * The full range (owner 2026-11-12: "Can't it go up to 4x? Show a battle at
 * 4x with a few broadsides, then slow to 0.25 and zoom in maybe?"). The
 * capital-broadside fight (same room, params and setup cue), spectated. The
 * sector goes to 4× right after the fight starts (setup), so the 16" turrets
 * train in ~7 s of wall time (they need ~25–28 game s) and the take opens on
 * batteries already firing at the top speed: the 30 s reload is 7.5 s of
 * wall time, so the first ~9 s hold several broadsides. The camera frames the
 * battleship and its target (the whole line is too spread out to see shells).
 * The pilot locks the battleship in setup (a live player lock keeps the NPCs
 * hostile at any speed). Then the dial goes to 0.25× (the dimmer halves the
 * speed once a second: ~4 s) while the camera closes in on the battleship:
 * deep slow motion, close up.
 *
 * (Hostile review 2026-11-12 of a 0.4×/2× version: the turrets were still
 * training through 1× and 0.4×, and a frame on every ship made shells
 * invisible. Both fixed here; that shot was dropped.)
 */
export const timeScaleCapitals4x: Shot = {
  id: 'time-scale-capitals-4x',
  section: 'mechanics',
  title: 'Game speed: 4× to 0.25×',
  caption: 'The full range of the speed dial on a capital battle: broadsides at 4×, then a glide down to 0.25× while the camera closes in on the battleship.',
  features: ['CAP', 'M19'],
  docs: ['game-speed'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capitals-combat', params: { sectorScale: '4', shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1 } },
  durationMs: 32_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.spectate();
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-capitals-4x: no room id on the client');
    const bs = await battleshipId(ctx);
    if (!bs) throw new Error('time-scale-capitals-4x: no battleship in view');
    ctx.log(`  [time-scale] pilot locks the battleship with ${await lockBattleship(ctx, bs)} group(s)`);
    await snapSpeed(ctx, id, 4);
    // ~28 game s at 4×: the 16" turrets finish training and open fire.
    await ctx.sleep(7500);
    // Frame the battleship and its target, so shells cross a readable frame.
    await ctx.cinema.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', ids: [bs, 'local'], padding: 0.25, maxZoom: 2.5 } }]);
    await ctx.sleep(1000);
  },
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-capitals-4x: no room id on the client');
    await ctx.sleep(9000); // broadsides at 4×
    await dial(ctx, id, 0.25); // glides down in ~7.5 s
    const bs = await battleshipId(ctx);
    // Close in tight on the battleship as it slows (fit the hull, higher cap).
    if (bs) await ctx.cinema.play([{ atMs: 0, smoothMs: 4000, shot: { kind: 'frame', ids: [bs], padding: 0.08, maxZoom: 8 } }]);
    await ctx.sleep(11_000); // the glide (~4 s), then ~7 s at 0.25×
  },
};
