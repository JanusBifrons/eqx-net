import type { Shot, ShotContext } from '../types.js';
import { flyRoute } from './_pilot.js';

/** Live NPC ships in the pilot's mirror. */
async function npcCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n;
  }).catch(() => 0);
}

/** Is the pilot still flying (not spectating after a death)? */
async function piloting(ctx: ShotContext): Promise<boolean> {
  return ctx.page.evaluate(() => {
    const s = (globalThis as { __eqxStore?: { getState(): { pilotMode?: string } } }).__eqxStore?.getState();
    return s?.pilotMode !== 'spectator';
  }).catch(() => false);
}

/**
 * Friendly fire and the fight rules (allegiances.md "Fire paths"), filmed as a
 * player sees it. A drone pack and a robot squad (sides that fight on sight)
 * are posed in two ranks each, shields up, and are already fighting when the
 * take opens. A fighter flies in from the south with the follow camera and its
 * own guns on AUTO: they lock (lock-to-fire) and fire at the robots, which are
 * hostile to it on sight and lock it back (the threat ring). Rear ranks hold
 * fire while an ally is in the line and hit their own side when one drifts in
 * after the shot; shields meet as bubbles. No test cues at all: no aggro, no
 * survive params, no lock cues. If the fighter dies, the take keeps rolling in
 * the spectator view the game switches to.
 */
export const fleetMelee: Shot = {
  id: 'fleet-melee',
  section: 'mechanics',
  title: 'Fleet melee',
  caption: 'A fighter joins a drone-versus-robot fight: guns fire only once locked, NPCs hold fire when an ally is in the way and still hit their own side when one drifts in, shields collide as bubbles.',
  features: ['M19'],
  docs: ['allegiances', 'fire-control'],
  reel: false,
  server: 'lean',
  target: { room: 'showcase-melee', params: { shipKind: 'fighter' } },
  durationMs: 45_000,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n >= 12;
    }, undefined, { timeout: 60_000, polling: 250 });
    // The two sides close and open fire on their own; start once they are at it.
    await ctx.sleep(5000);
    ctx.log(`  [fleet-melee] NPCs at take start: ${await npcCount(ctx)}`);
  },
  async run(ctx) {
    const t0 = Date.now();
    await ctx.sleep(1000);
    // Fly north into the fight, then work along the robots' side of it.
    const legs: Array<[number, number]> = [[0, -450], [250, -150], [350, 200], [0, 350], [-200, 50], [150, -250], [300, 150]];
    for (const leg of legs) {
      if (Date.now() - t0 > 42_000 || !(await piloting(ctx))) break;
      await flyRoute(ctx, [leg], { arrive: 120, maxMs: Math.min(7000, 43_000 - (Date.now() - t0)) });
    }
    ctx.log(`  [fleet-melee] t=${((Date.now() - t0) / 1000).toFixed(1)}s piloting=${await piloting(ctx)} NPCs=${await npcCount(ctx)}`);
    const left = 44_000 - (Date.now() - t0);
    if (left > 0) await ctx.sleep(left);
    ctx.log(`  [fleet-melee] end piloting=${await piloting(ctx)} NPCs=${await npcCount(ctx)}`);
  },
};
