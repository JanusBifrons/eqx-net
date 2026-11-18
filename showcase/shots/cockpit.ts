/**
 * "From the cockpit" — this week's features filmed from one piloted ship.
 * The camera tracks the local ship; the HUD shows what a player sees (wallet,
 * cargo, shield/hull). Flight is steered by `_pilot.ts`.
 */
import type { Shot } from '../types.js';
import { AS_PILOT, SURVIVE } from './_helpers.js';
import { keepClearBox } from '../../src/core/structures/placementRules.js';
import { SCENARIO } from '../../src/server/rooms/scenarioLayouts.js';
import { face, flyRoute, flyTo, localPose, parkAt } from './_pilot.js';

const TRACK = (zoom: number) => [{ atMs: 0, smoothMs: 300, shot: { kind: 'track' as const, target: 'local', zoom, leadMs: 250 } }];

/** Pose of the first swarm entity matching a predicate, from the client mirror. */
async function swarmPose(
  ctx: Parameters<NonNullable<Shot['run']>>[0],
  what: 'elite' | 'pod',
): Promise<{ id: number; x: number; y: number } | null> {
  return ctx.page.evaluate((w) => {
    const m = (window as unknown as {
      __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string; eliteName?: string; x: number; y: number }> } };
    }).__eqxClient?.mirror;
    for (const [id, e] of m?.swarm ?? []) {
      if (w === 'pod' && e.kind === 3 && e.shipKind === 'cargo-pod') return { id, x: e.x, y: e.y };
      if (w === 'elite' && e.kind === 1 && e.eliteName) return { id, x: e.x, y: e.y };
    }
    return null;
  }, what);
}

/** Arrive at an NPC stronghold and fly in through its open south gate. */
export const cockpitStronghold: Shot = {
  id: 'cockpit-stronghold',
  section: 'mechanics',
  title: 'Visiting an NPC base',
  caption: 'Every sector grows its own NPC bases. Their gates open for anyone they aren’t at war with — fly straight in.',
  features: ['T10'],
  docs: [],
  reel: true,
  server: 'lean',
  target: { room: 'npc-base-stronghold', params: { shipKind: 'fighter', spawnX: 0, spawnY: -2250 } },
  hud: 'clean',
  durationMs: 15_000,
  camera: TRACK(0.9),
  async run(ctx) {
    await ctx.sleep(600);
    await flyRoute(ctx, [[0, -1700], [0, -1000], [700, -700]], { cruise: 330, maxMs: 6500 });
  },
};

/** Fly cargo home past the Miner drilling its asteroid, park in the Capital's
 *  crane bay (its only drop-off, structure-restyle 3f) and let its crane unload
 *  you: settle, reach, hold (3..10 s with load), bank, retract. The homestead
 *  Capital is turned (`SCENARIO.capital.rot`), so its bay opens west, on the
 *  way in from the Miner. */
export const cockpitHaul: Shot = {
  id: 'cockpit-haul',
  section: 'mechanics',
  title: 'Mining and hauling',
  caption: 'Your Miner drills the asteroid while you haul cargo home — park in your Capital’s bay and its crane unloads you.',
  features: ['M27'],
  docs: ['loot-and-cargo'],
  reel: true,
  server: 'lean',
  ...AS_PILOT,
  target: { room: 'showcase-homestead', params: { shipKind: 'fighter', initialCargo: 'salvage:30,alloy:12', zoom: 1 } },
  hud: 'clean',
  durationMs: 40_000,
  endsWithRun: true,
  // The game's follow camera (a piloted take has no camera script).
  async run(ctx) {
    const t0 = Date.now();
    await ctx.sleep(500);
    // Past the Miner to the Capital's west side, where its bay opens.
    await flyRoute(ctx, [[-950, -950], [-560, -200]], { cruise: 200, arrive: 200, maxMs: 9000 });
    const { x: bx, y: by } = keepClearBox('capital', SCENARIO.capital.x, SCENARIO.capital.y, SCENARIO.capital.rot)!;
    const bay = { x: bx, y: by };
    if (!(await parkAt(ctx, bay.x, bay.y, 10_000))) ctx.log('cockpit-haul: not still on the bay');
    // Hands off while the crane works; the take ends once it has banked the
    // hold and swung back.
    const banked = ctx.page.getByTestId('loot-feed-line').filter({ hasText: 'Banked' });
    await banked.waitFor({ state: 'visible', timeout: 16_000 }).then(
      () => ctx.log(`cockpit-haul: Banked at ${Date.now() - t0} ms`),
      () => ctx.log('cockpit-haul: no Banked line'),
    );
    await ctx.sleep(2_500);
  },
};

/** Hunt a named elite: the kill pays its bounty, then collect the loot pod. */
export const cockpitBounty: Shot = {
  id: 'cockpit-bounty',
  section: 'mechanics',
  title: 'Bounty hunting',
  caption: 'Named elites carry a bounty. Bring one down and the credits land in your wallet — then grab what it dropped.',
  features: ['M19'],
  docs: ['bounties-and-events'],
  reel: true,
  server: 'lean',
  target: { room: 'showcase-bounty', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'clean',
  durationMs: 18_000,
  camera: TRACK(1.1),
  async run(ctx) {
    const end = Date.now() + 13_000;
    // Close to beam range and stay on the elite until it dies.
    while (Date.now() < end) {
      const e = await swarmPose(ctx, 'elite');
      if (!e) break;
      const p = await localPose(ctx);
      const toward = p ? Math.hypot(e.x - p.x, e.y - p.y) : 999;
      // Close to beam range nose-first, then keep the nose (and beams) on it.
      if (toward > 220) await flyTo(ctx, e.x, e.y, { arrive: 210, cruise: 240, maxMs: 1200, passThrough: true });
      else await face(ctx, e.x, e.y, 400);
    }
    const pod = await swarmPose(ctx, 'pod');
    if (pod) await flyTo(ctx, pod.x, pod.y, { arrive: 40, cruise: 200, maxMs: 4000 });
  },
};

/** In the middle of a three-way fight: robots, drones and you. */
export const cockpitRobots: Shot = {
  id: 'cockpit-robots',
  section: 'mechanics',
  title: 'Rival factions',
  caption: 'Robot squads fight the drones on sight — and anyone else in reach. Pick your moment.',
  features: ['M19'],
  docs: [],
  reel: true,
  server: 'lean',
  target: { room: 'robots-showcase', params: { shipKind: 'heavy', spawnX: 0, spawnY: 0, ...SURVIVE } },
  hud: 'clean',
  durationMs: 14_000,
  camera: TRACK(0.85),
  async run(ctx) {
    await ctx.sleep(400);
    await flyRoute(ctx, [[0, 380], [250, 520]], { cruise: 200, arrive: 120, maxMs: 9000 });
  },
};
