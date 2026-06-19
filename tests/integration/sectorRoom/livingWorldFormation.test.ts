/**
 * Non-combat herding — roaming squads fly as a leader-led FLOCK inside a sector.
 *
 * Playtest ask (the redesign): "designate a leader given a course, then use
 * flocking/herding to guide the rest with distance + simple steering" — plus the
 * follow-up "they just need to slow down once close… you can also just make the
 * leader wait." The director's `flockStep` designates the first active member the
 * LEADER (given a wandering in-sector course via `setBotFlockLeaderCourse`, which
 * THROTTLES its cruise; it HOLDS at its own pose while the squad is spread) and
 * marks every other member a FOLLOWER (via `setBotFlockFollow`) that herds to the
 * leader's LIVE pose each tick (cohesion+arrival/alignment/separation in
 * `HostileDroneBehaviour.tickFlock`, NO boost — the leader-wait closes the gap).
 *
 * This lives at the multi-room director level (the behaviour LIVES here — real
 * squad gather + real room hooks + real physics); the pure boids math is
 * unit-tested in src/core/ai/flocking.test.ts and the brain wiring in
 * HostileDroneBehaviour.flock.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';

describe('LivingWorldDirector — leader-led flock (non-combat herding)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('designates ONE leader + flocks the rest, and the squad flies as a cohesive group', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8, // one full squad (SQUAD_SIZE)
      seed: 11,
    });
    // greenfall is the only entry sector in this set → the squad gathers there.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      8000,
      'squad gathered at its home edge',
    );

    // Spy on the role assignments the director pushes to the room (it calls this
    // room instance, so shadowing records every assignment while still driving
    // the real behaviour).
    const room = h.getRoom('greenfall');
    const leaderCourses: string[] = []; // bots given a leader course (leaders)
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

    // Within a control tick, flockStep designates a leader + assigns 7 followers.
    await h.waitUntil(
      () => new Set(followAssigns.map((c) => c.botId)).size >= 7,
      6000,
      'flock roles assigned (7 followers)',
    );

    // ── Role shape: exactly one leader, seven followers, all to that leader ──
    const leaderId = leaderCourses[0]!;
    const followerIds = new Set(followAssigns.map((c) => c.botId));
    expect(new Set(leaderCourses).size).toBe(1); // one designated leader
    expect(followerIds.size).toBe(7); // the other seven
    expect(followerIds.has(leaderId)).toBe(false); // leader isn't its own follower
    expect(followAssigns.every((c) => c.leaderId === leaderId)).toBe(true); // all follow it

    // ── Behaviour: the squad is BORN clustered (members share a per-squad edge
    //    anchor, `squadEdgePose`, so a squad warps in as a herd — NOT scattered
    //    across the whole sector edge), and flocking TIGHTENS + holds it at the
    //    equilibrium spacing while the herd flies as a group. The faithful
    //    properties: spawns clustered, ends TIGHT, and is alive (moving). ──
    const botIds = Array.from({ length: 8 }, (_, i) => `lwbot-${i}`);
    const poseMap = (): Map<string, { x: number; y: number }> => {
      const m = new Map<string, { x: number; y: number }>();
      for (const id of botIds) {
        const p = room.getBotPose(id);
        if (p) m.set(id, { x: p.x, y: p.y });
      }
      return m;
    };
    const maxFollowerGap = (poses: Map<string, { x: number; y: number }>): number => {
      const lp = poses.get(leaderId);
      if (!lp) return Infinity;
      let m = 0;
      for (const [id, p] of poses) {
        if (id === leaderId) continue;
        const d = Math.hypot(p.x - lp.x, p.y - lp.y);
        if (d > m) m = d;
      }
      return m;
    };

    const before = poseMap();
    const gap0 = maxFollowerGap(before);
    await h.advance(16_000); // let flocking tighten the herd + the leader cruise
    const after = poseMap();
    const gap1 = maxFollowerGap(after);

    // (a) BORN CLUSTERED — the squad spawned as a herd (shared edge anchor), not
    //     scattered across the sector edge (which was ~9000 u, the diameter).
    expect(gap0).toBeLessThan(1500);
    // (b) TIGHT HERD — flocking holds the farthest follower close to the leader
    //     (cohesion pulls in, separation spaces ~150; the herd settles ~a few
    //     hundred u across, never strung out).
    expect(gap1).toBeLessThan(400);
    // (c) ALIVE — bots actually steered + moved (the herd flies, not a frozen
    //     blob). Sum every bot's displacement over the window.
    let totalDisp = 0;
    for (const [id, b] of before) {
      const a = after.get(id);
      if (a) totalDisp += Math.hypot(a.x - b.x, a.y - b.y);
    }
    expect(totalDisp).toBeGreaterThan(200);
  }, 60_000);

  it('a ROAMING squad re-forms in the CENTRAL, player-visible zone on hop arrival (not the far edge)', async () => {
    // The live-diagnosis regression lock. The flock MATH was always correct (the
    // test above proves a gathered squad is tight) — but in live play the herd was
    // never SEEN: squads spawn at the ~4600 u sector EDGE and the old leader course
    // targeted a radius-2000 ring, while the ~45 s roam dwell was shorter than the
    // edge→centre cruise, so the herd perpetually orbited the OUTER ring at/beyond
    // a central player's interest + view. The fix lands a ROAMING squad clustered in
    // the CENTRAL zone (`squadCentralPose`) on hop arrival + shrinks the leader's
    // wander ring, so the herd patrols where players are. This asserts the property
    // the gathered-squad test above structurally CANNOT: a herd reached by ROAMING is
    // central, not at the edge.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8,
      seed: 11,
      director: { roamIntervalMs: 1000, hopTravelMs: 40 },
    });
    // Seeds + gathers at its home ENTRY edge (greenfall) — an EDGE spawn (~4600 u).
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      6000,
      'squad gathered at its home edge',
    );
    // Roams (a real hop) into the interior neighbour and re-forms there.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['emerald-span']!.bots === 8,
      8000,
      'squad roamed (hopped) into the interior neighbour',
    );

    const room = h.getRoom('emerald-span');
    const present: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 8; i++) {
      const p = room.getBotPose(`lwbot-${i}`);
      if (p) present.push({ x: p.x, y: p.y });
    }
    // Tolerate a member that may have begun the next roam leg between the poll and
    // the read; the herd is still overwhelmingly present in the interior.
    expect(present.length).toBeGreaterThanOrEqual(7);

    // (a) CENTRAL — every present member re-formed near the sector CENTRE (origin),
    //     FAR below the ~4600 u edge the old `squadEdgePose` arrival produced. The
    //     leader patrols a radius-~1000 ring, so allow generous central headroom
    //     (< 1500) — still an unambiguous discriminator vs the edge.
    const maxRadius = Math.max(...present.map((p) => Math.hypot(p.x, p.y)));
    expect(maxRadius).toBeLessThan(1500);

    // (b) TIGHT — a cohesive cluster around its centroid (flocking still holds the
    //     herd together post-arrival), never strung out across the sector.
    const cx = present.reduce((a, p) => a + p.x, 0) / present.length;
    const cy = present.reduce((a, p) => a + p.y, 0) / present.length;
    const maxGap = Math.max(...present.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    expect(maxGap).toBeLessThan(800);
  }, 30_000);
});
