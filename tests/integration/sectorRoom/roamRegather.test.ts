/**
 * WS-E #9 — roaming squads keep flock roles assigned so they don't scatter.
 *
 * USER REPORT (on-device): "After a few attacks the drones ended up spread out
 * weirdly … none of them retreated."
 *
 * The anti-scatter mechanism is the leader-led FLOCK: flockStep designates a
 * leader (a held/throttled course) + marks every other member a follower that
 * herds to the leader's live pose each tick. If that role assignment is bypassed
 * for a roaming squad (the old "only idle+gathered" gate), the herd has no
 * cohesion force and spreads out.
 *
 * This integration test drives a roaming squad through a real hop and asserts the
 * director KEEPS assigning flock roles (one leader course + the rest as
 * followers) once the herd has gathered in the destination — the cohesion that
 * stops the scatter — and that the resulting herd stays tight. Spying on the room
 * hooks (like livingWorldFormation.test.ts) makes the mechanism assertion fail
 * LOUDLY if flockStep ever stops herding a roaming squad.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';

describe('SectorRoom integration — roaming squad keeps flock roles (WS-E #9)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('keeps assigning leader + follower flock roles to a roaming squad (anti-scatter)', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'verdance'],
      botCount: 8,
      seed: 11,
      director: { roamIntervalMs: 1000, hopTravelMs: 40 },
    });

    // Gather at the home entry edge, then roam (a real hop) into the interior.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      6000,
      'squad gathered at its home edge',
    );
    await h.waitUntil(
      () => h!.director.snapshot().perSector['verdance']!.bots >= 7,
      8000,
      'roaming squad hopped into the interior neighbour',
    );

    // Spy on the role assignments the director pushes to the DESTINATION room.
    const room = h.getRoom('verdance');
    const leaderCourses: string[] = [];
    const followAssigns: Array<{ botId: string; leaderId: string }> = [];
    const origCourse = room.setBotFlockLeaderCourse.bind(room);
    room.setBotFlockLeaderCourse = (botId: string, x: number, y: number): void => {
      leaderCourses.push(botId);
      origCourse(botId, x, y);
    };
    const origFollow = room.setBotFlockFollow.bind(room);
    room.setBotFlockFollow = (botId: string, leaderId: string, memberIds: readonly string[]): void => {
      followAssigns.push({ botId, leaderId });
      origFollow(botId, leaderId, memberIds);
    };

    // The roaming squad (now idle in the interior) keeps getting herded: a leader
    // course + followers, every control tick. Without flockStep running for the
    // roamer, NEITHER is ever called (the scatter).
    await h.waitUntil(
      () => leaderCourses.length > 0 && new Set(followAssigns.map((c) => c.botId)).size >= 6,
      8000,
      'flock roles assigned to the roaming squad (leader + ≥6 followers)',
    );
    expect(leaderCourses.length).toBeGreaterThan(0);
    expect(new Set(followAssigns.map((c) => c.botId)).size).toBeGreaterThanOrEqual(6);

    // And the herd stays tight (the cohesion the roles drive).
    await h.advance(2000);
    const present: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 8; i++) {
      const p = room.getBotPose(`lwbot-${i}`);
      if (p) present.push({ x: p.x, y: p.y });
    }
    const cx = present.reduce((a, p) => a + p.x, 0) / present.length;
    const cy = present.reduce((a, p) => a + p.y, 0) / present.length;
    const maxGap = Math.max(...present.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    expect(maxGap).toBeLessThan(900);
  }, 30_000);
});
