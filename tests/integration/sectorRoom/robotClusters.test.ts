/**
 * Living World follow-up — robot squads roaming the same sector MERGE into one
 * bigger cluster, through the real robot director over real SectorRooms.
 *
 *  1. two robot squads arriving in one sector merge (the later joins the
 *     earlier) once both have gathered there;
 *  2. the joined squad's bots flock on the HOST's leader (one pack);
 *  3. when the host roams on, the joined squad takes the same goal, so the
 *     cluster travels together.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { ROBOT_DIRECTOR_OPTIONS, ROBOT_SQUAD_LAYOUT } from '../../../src/server/livingworld/robotDirector.js';

describe('SectorRoom integration — robot clusters merge', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('two robot squads in one sector merge, flock as one pack, and roam together', { timeout: 40_000 }, async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 12,
      seed: 5,
      director: {
        ...ROBOT_DIRECTOR_OPTIONS,
        botCount: 12,
        squadLayout: { ...ROBOT_SQUAD_LAYOUT, squadCount: 2 },
        controlIntervalMs: 50,
        roamIntervalMs: 60_000, // hold still until we've checked the merge
      },
    });
    await h.waitUntil(() => h!.director.snapshot().active === 12, 10_000, 'all 12 robots in');
    await h.waitUntil(() => h!.director.clusters().size === 1, 8000, 'the two squads merged');
    const [[joinerId, hostId]] = [...h.director.clusters()];
    const sector = h.director.squadGoalOf(hostId)!;
    expect(h.director.squadGoalOf(joinerId)).toBe(sector);

    // 2. The joined squad's bots follow the HOST's leader.
    const room = h.getRoom(sector);
    const follows: Array<{ bot: string; leader: string; pack: number }> = [];
    const orig = room.setBotFlockFollow.bind(room);
    room.setBotFlockFollow = (bot: string, leader: string, members: readonly string[]): void => {
      follows.push({ bot, leader, pack: members.length });
      orig(bot, leader, members);
    };
    await h.advance(300);
    const pack = h.director.clusterMembersOf(hostId, sector);
    expect(pack.length).toBe(12);
    const hostLeader = pack[0]!;
    const joinerBots = pack.slice(6);
    for (const b of joinerBots) {
      const last = follows.filter((f) => f.bot === b).pop();
      expect(last?.leader, `${b} follows the host leader`).toBe(hostLeader);
      expect(last?.pack).toBe(12);
    }

    // 3. Let the host roam on: the joined squad takes the same goal.
    (h.director as unknown as { opts: { roamIntervalMs: number } }).opts.roamIntervalMs = 50;
    (h.director as unknown as { squadRoamNextAtMs: Map<string, number> }).squadRoamNextAtMs.set(hostId, 0);
    await h.waitUntil(() => h!.director.squadGoalOf(hostId) !== sector, 8000, 'the host roamed on');
    expect(h.director.squadGoalOf(joinerId)).toBe(h.director.squadGoalOf(hostId));
  });

  it('drone squads never merge (the option is robots-only)', async () => {
    h = await bootLivingWorldTestServer({ sectors: ['greenfall'], botCount: 16, seed: 3 });
    await h.waitUntil(() => h!.director.snapshot().active === 16, 10_000, 'drones in');
    await h.advance(500);
    expect(h.director.clusters().size).toBe(0);
  });
});
