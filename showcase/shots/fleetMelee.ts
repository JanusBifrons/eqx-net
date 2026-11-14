import type { Shot, ShotContext } from '../types.js';

/** Live AI-flown ships (drones and robots) in the spectator's mirror. */
async function aiShipCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1) n++; });
    return n;
  }).catch(() => 0);
}

/** Live robots in the mirror (works while spectating). */
async function robotCount(ctx: ShotContext): Promise<number> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    let n = 0;
    m?.swarm.forEach((e) => { if (e.kind === 1 && e.shipKind?.startsWith('robot')) n++; });
    return n;
  }).catch(() => 0);
}

/**
 * Ids of the live drone-faction ships, fighters first, each group by
 * ascending id: the follow order. The pilot's own ship is not in the swarm
 * mirror, so every entry here is flown by its AI pilot.
 */
async function droneFollowOrder(ctx: ShotContext): Promise<number[]> {
  return ctx.page.evaluate(() => {
    const m = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
    const fighters: number[] = [];
    const others: number[] = [];
    m?.swarm.forEach((e, id) => {
      if (e.kind !== 1 || !e.shipKind || e.shipKind.startsWith('robot')) return;
      (e.shipKind === 'fighter' ? fighters : others).push(id);
    });
    fighters.sort((a, b) => a - b);
    others.sort((a, b) => a - b);
    return [...fighters, ...others];
  }).catch(() => []);
}

/** Follow-camera zoom on the followed fighter (1920-wide frame). */
const FOLLOW_ZOOM = 1.0;

/** Point the cinematic camera at one AI-flown ship: the follow spring of
 *  play (a switch reads as a quick ~250 ms cut). */
async function follow(ctx: ShotContext, id: number): Promise<void> {
  const k = ctx.viewport.width / 1920;
  await ctx.cinema.play([{ atMs: 0, smoothMs: 250, shot: { kind: 'track', target: `swarm-${id}`, zoom: FOLLOW_ZOOM * k, leadMs: 250 } }]);
}

/**
 * Friendly fire and the fight rules (allegiances.md "Fire paths"), seen from
 * one AI pilot's side. A drone pack and a robot squad (sides that fight on
 * sight) are posed in two ranks each, shields up, and are already fighting
 * when the take opens. The pilot joins and spectates (owner decision
 * 2026-11-14: the followed ship is flown by its AI pilot, not a test
 * script); the camera follows the first drone-faction fighter by id. If it
 * dies, the camera cuts to the next drone fighter (then any drone ship), so
 * the clip stays on the action. The AI pilots hold fire while an ally is in
 * the line and hit their own side when one drifts in after the shot; shields
 * meet as bubbles. No test cues at all: no aggro, no survive params, no lock
 * cues. The take ends ~3 s after the last robot dies (`endsWithRun`).
 */
export const fleetMelee: Shot = {
  id: 'fleet-melee',
  section: 'mechanics',
  title: 'Fleet melee',
  caption: 'A drone-faction fighter flown by its AI pilot in a melee against the robot faction; the AI pilots hold fire while an ally is in the line and can still hit their own side.',
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
    // Watch as a spectator: the camera may then follow an AI-flown ship.
    await ctx.spectate();
    const order = await droneFollowOrder(ctx);
    if (order.length === 0) throw new Error('fleet-melee: no drone-faction ship to follow');
    await follow(ctx, order[0]!);
    // The two sides close and open fire on their own; roll once they meet.
    await ctx.sleep(2000);
    ctx.log(`  [fleet-melee] AI ships at take start: ${await aiShipCount(ctx)}; following swarm-${order[0]}`);
  },
  async run(ctx) {
    const t0 = Date.now();
    const left = (): number => 44_000 - (Date.now() - t0);
    const t = (): string => ((Date.now() - t0) / 1000).toFixed(1);
    // The fighter followed at take start (startWhen picked it; re-read in
    // case it died during the 2 s settle).
    let order = await droneFollowOrder(ctx);
    let followed = order[0] ?? null;
    if (followed !== null) await follow(ctx, followed);
    ctx.log(`  [fleet-melee] t=${t()}s following swarm-${followed}`);
    // Stay on the followed ship; when it dies, cut to the next one in the
    // follow order. Once the last robot is gone, hold ~3 s on the aftermath
    // and end the take (endsWithRun).
    while (left() > 0 && (await robotCount(ctx)) > 0) {
      order = await droneFollowOrder(ctx);
      if (followed === null || !order.includes(followed)) {
        const next = order[0] ?? null;
        if (next !== null) {
          ctx.log(`  [fleet-melee] t=${t()}s swarm-${followed} gone; cut to swarm-${next}`);
          followed = next;
          await follow(ctx, next);
        } else if (followed !== null) {
          ctx.log(`  [fleet-melee] t=${t()}s no drone-faction ship left`);
          followed = null;
        }
      }
      await ctx.sleep(Math.min(250, left()));
    }
    if (left() > 0) await ctx.sleep(Math.min(3000, left()));
    ctx.log(`  [fleet-melee] end t=${t()}s following swarm-${followed} AI ships=${await aiShipCount(ctx)} robots=${await robotCount(ctx)}`);
  },
};
