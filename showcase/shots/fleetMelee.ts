import type { Shot, ShotContext } from '../types.js';
import { flyTo, face } from './_pilot.js';

/** Live NPC ships in the pilot's mirror. */
async function npcCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n;
  }).catch(() => 0);
}

/** Live robots in the pilot's mirror (works while spectating too). */
async function robotCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1 && e.shipKind?.startsWith('robot')) n++; });
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

/** The nearest robot (the side hostile to the pilot), as a player picks a foe. */
async function nearestRobot(ctx: ShotContext): Promise<{ x: number; y: number } | null> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId?: string | null; ships: Map<string, { x: number; y: number }>; swarm: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    if (!m || !me) return null;
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    m.swarm.forEach((e) => {
      if (e.kind !== 1 || !e.shipKind?.startsWith('robot')) return;
      const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (d < bd) { bd = d; best = { x: e.x, y: e.y }; }
    });
    return best;
  }).catch(() => null);
}

/**
 * Friendly fire and the fight rules (allegiances.md "Fire paths"), filmed as a
 * player sees it. A drone pack and a robot squad (sides that fight on sight)
 * are posed in two ranks each, shields up, and are already fighting when the
 * take opens. A fighter flies in from the south with the follow camera and
 * goes after the nearest robot (robots are hostile to pilots on sight), with
 * its gun group on AUTO: it fires only once its lock completes, and the robots
 * lock it back (the threat ring). NPCs hold fire while an ally is in the line
 * and hit their own side when one drifts in after the shot; shields meet as
 * bubbles. No test cues at all: no aggro, no survive params, no lock cues. If
 * the fighter dies, the take keeps rolling in the spectator view the game
 * switches to. The take ends ~3 s after the last robot dies (`endsWithRun`),
 * so the clip doesn't idle after the fight (it used to run on ~35 s).
 */
export const fleetMelee: Shot = {
  id: 'fleet-melee',
  section: 'mechanics',
  title: 'Fleet melee',
  caption: 'A fighter joins a drone-versus-robot fight already under way and goes after the robots, firing only once locked; the NPCs hold fire while an ally is in the line and can still hit their own side.',
  features: ['M19'],
  docs: ['allegiances', 'fire-control'],
  reel: false,
  server: 'lean',
  target: { room: 'showcase-melee', params: { shipKind: 'fighter' } },
  durationMs: 45_000,
  endsWithRun: true,
  async startWhen(ctx) {
    await ctx.page.waitForFunction(() => {
      const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
      let n = 0;
      m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n >= 12;
    }, undefined, { timeout: 60_000, polling: 250 });
    // The two sides close and open fire on their own; roll once they meet.
    await ctx.sleep(2000);
    ctx.log(`  [fleet-melee] NPCs at take start: ${await npcCount(ctx)}`);
  },
  async run(ctx) {
    const t0 = Date.now();
    const left = (): number => 44_000 - (Date.now() - t0);
    while (left() > 1000 && (await piloting(ctx))) {
      const r = await nearestRobot(ctx);
      if (!r) break; // the robots are gone: the pilot sits and watches the rest
      // Close to gun range, then hold the nose on it for a moment.
      await flyTo(ctx, r.x, r.y, { arrive: 220, maxMs: Math.min(3000, left()), cruise: 260, passThrough: true });
      const r2 = await nearestRobot(ctx);
      if (r2 && left() > 1000) await face(ctx, r2.x, r2.y, 700);
    }
    ctx.log(`  [fleet-melee] t=${((Date.now() - t0) / 1000).toFixed(1)}s piloting=${await piloting(ctx)} NPCs=${await npcCount(ctx)}`);
    // Watch the rest of the fight; once the last robot is gone, hold ~3 s on
    // the aftermath and end the take (endsWithRun).
    while (left() > 0 && (await robotCount(ctx)) > 0) await ctx.sleep(Math.min(500, left()));
    if (left() > 0) await ctx.sleep(Math.min(3000, left()));
    ctx.log(`  [fleet-melee] end piloting=${await piloting(ctx)} NPCs=${await npcCount(ctx)}`);
  },
};
