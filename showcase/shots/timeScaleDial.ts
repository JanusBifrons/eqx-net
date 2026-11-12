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

/** Salvo ids the client currently knows (shells as events). */
async function salvoIds(ctx: ShotContext): Promise<string[]> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { shellSalvos?: Map<string, unknown> } } }).__eqxClient?.mirror;
    return m?.shellSalvos ? [...m.shellSalvos.keys()] : [];
  }).catch(() => [] as string[]);
}

/** Distance from the pilot to the battleship (u), or Infinity. */
async function battleshipDistance(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId?: string; ships: Map<string, { x: number; y: number }>; swarm: Map<number, { kind: number; x: number; y: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    let d = Infinity;
    m?.swarm.forEach((e) => { if (me && e.kind === 1 && e.shipKind === 'battleship') d = Math.hypot(e.x - me.x, e.y - me.y); });
    return d;
  }).catch(() => Infinity);
}

/** Turn the mouse wheel `n` notches (+ = out, each x0.9 / x1.1), as a player would. */
async function wheelSteps(ctx: ShotContext, dy: number, n: number, gapMs: number): Promise<void> {
  const c = ctx.px(960, 540);
  await ctx.page.mouse.move(c.x, c.y);
  for (let i = 0; i < n; i++) { await ctx.page.mouse.wheel(0, dy); await ctx.sleep(gapMs); }
}

/**
 * The full range (owner 2026-11-12: "Can't it go up to 4x? Show a battle at
 * 4x with a few broadsides, then slow to 0.25 and zoom in maybe?"). The
 * capital duel as it plays (showcase-capital-duel: one battleship, the
 * pilot's heavy cruiser 4,000 u off its beam, where only the 16" battery
 * reaches), seen from the pilot's own camera.
 *
 * Setup:
 * - the pilot spawns 3,000 u off the battleship (inside the heavy cruiser's own
 *   main-battery lock reach, ~3,540 u), and one `test_aggro` cue goes in as soon
 *   as the battleship is in view, so it comes to fight instead of wandering;
 * - the pilot locks the battleship through the client's own `requestLock` (a
 *   live player lock keeps an NPC hostile, owner rule 2026-11-10; otherwise
 *   the cue's hostility lapses after 30 GAME seconds, 7.5 s at 4×);
 * - the sector goes to 4×, and the player wheels out to their zoom floor;
 * - setup waits for the art to bake and the battleship to be within the
 *   cruiser's lock reach (the lock is what keeps the fight going: measured
 *   2026-11-12, from 4,000 u the locks never complete and the battleship fires
 *   one volley, then the cue's hostility lapses 30 game s later).
 *
 * The take:
 * - runs at 4× until it has SEEN two 16" volleys (salvo events), so the
 *   broadsides are filmed whatever the training and reload timing;
 * - then the dial goes to 0.25× while the second volley is in flight (the
 *   dimmer halves the speed once a second), and the player zooms in on their
 *   own ship with the wheel, so the shells crawl the last of the way and land
 *   in slow motion.
 *
 * NOT a spectator take: spectating parks the pilot's hull, and the
 * battleship never fires at a parked hull (measured 2026-11-12 at 1× and 4×
 * alike), so a held spectator camera would film no broadsides. Earlier
 * versions: the five-capital line-up held every gun (the pilot spawned among
 * the ships, so line-of-fire and own-deck rules applied).
 */
export const timeScaleCapitals4x: Shot = {
  id: 'time-scale-capitals-4x',
  section: 'mechanics',
  title: 'Game speed: 4× to 0.25×',
  caption: 'The full range of the speed dial: a battleship’s 16-inch broadsides at 4×, then a glide down to 0.25× while the shells are in flight, as the pilot zooms in on where they land.',
  features: ['CAP', 'M19'],
  docs: ['game-speed'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-capital-duel', params: { shipKind: 'heavy-cruiser', art: 'machined', fx: 'new', initialHull: 1_000_000, noselfdmg: 1, spawnX: 3000, spawnY: 0 } },
  durationMs: 60_000,
  endsWithRun: true,
  async startWhen(ctx) {
    // Start the fight as soon as the battleship is in view, so it comes to
    // fight instead of wandering off while the art bakes.
    await ctx.page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } }; __eqxStore?: { getState(): { fcGroups?: unknown[] } } }).__eqxClient;
      const g = (globalThis as { __eqxStore?: { getState(): { fcGroups?: unknown[] } } }).__eqxStore?.getState().fcGroups ?? [];
      let n = 0;
      c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0 && g.length > 0;
    }, null, { timeout: 60_000, polling: 250 });
    await sendRoom(ctx, 'test_aggro', { type: 'test_aggro' });
    const bs = await battleshipId(ctx);
    if (!bs) throw new Error('time-scale-capitals-4x: no battleship in view');
    ctx.log(`  [time-scale] pilot locks the battleship with ${await lockBattleship(ctx, bs)} group(s)`);
    await artSettled(ctx);
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-capitals-4x: no room id on the client');
    const t0 = Date.now();
    let d = Infinity;
    while (Date.now() - t0 < 90_000) {
      d = await battleshipDistance(ctx);
      if (d < 3400) break;
      await ctx.sleep(500);
    }
    ctx.log(`  [time-scale] battleship ${Math.round(d)} u from the pilot after ${((Date.now() - t0) / 1000).toFixed(1)} s of setup`);
    await snapSpeed(ctx, id, 4);
    await wheelSteps(ctx, 100, 20, 120); // out to the zoom floor
  },
  async run(ctx) {
    const id = await roomId(ctx);
    if (!id) throw new Error('time-scale-capitals-4x: no room id on the client');
    // 4× through two volleys. Each turret's firing is its own salvo; a volley
    // is a cluster of them (a gap of over 2 s starts the next volley).
    const seen = new Set<string>();
    const t0 = Date.now();
    let volleys = 0;
    let lastAt = -Infinity;
    let volley2At = 0;
    while (volleys < 2 && Date.now() - t0 < 30_000) {
      for (const sid of await salvoIds(ctx)) {
        if (seen.has(sid)) continue;
        seen.add(sid);
        const now = Date.now();
        if (now - lastAt > 2000) { volleys++; if (volleys === 2) volley2At = now; }
        lastAt = now;
      }
      await ctx.sleep(100);
    }
    ctx.log(`  [time-scale] ${volleys} volley(s) (${seen.size} turret salvos) at 4× in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // The next volley is ~7.5 s away at 4× (a 30-game-second reload). Turning the
    // dial ~6 s after volley two puts it in the air as the speed nears 0.3×
    // (the dimmer halves the speed once a second), so its shells crawl in.
    if (volley2At > 0) await ctx.sleep(Math.max(0, volley2At + 6_000 - Date.now()));
    await dial(ctx, id, 0.25);
    // The pilot zooms in on their own ship as the shells crawl in (x1.1 a notch).
    await ctx.sleep(1_500);
    await wheelSteps(ctx, -100, 12, 300);
    await ctx.sleep(8_000);
  },
};
