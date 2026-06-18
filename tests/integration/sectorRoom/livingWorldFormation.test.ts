/**
 * Non-combat herding — roaming squads fly as a leader-led FLOCK inside a sector.
 *
 * Playtest ask (the redesign): "designate a leader given a course, then use
 * flocking/herding to guide the rest with distance + simple steering." The
 * director's `flockStep` designates the first active member the LEADER (given a
 * wandering in-sector course via `setBotMoveTarget`) and marks every other member
 * a FOLLOWER (via `setBotFlockFollow`) that herds to the leader's LIVE pose each
 * tick (cohesion/alignment/separation in `HostileDroneBehaviour.tickFlock`).
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
    const leaderCourses: string[] = []; // bots given a move-target course (leaders)
    const followAssigns: Array<{ botId: string; leaderId: string }> = [];
    const origMove = room.setBotMoveTarget.bind(room);
    room.setBotMoveTarget = (botId: string, x: number, y: number): void => {
      leaderCourses.push(botId);
      origMove(botId, x, y);
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

    // ── Behaviour: the herd flies as a group AND converges (cohesion net-pulls-
    //    in, vs the old static blob that just sat). Drones are damping-limited to
    //    a slow cruise (~65 u/s) and the squad spawns spread around the sector
    //    edge, so the assertion is about TRENDS (moving + tightening), not a
    //    tight absolute radius (which would take minutes at drone speed). ──
    const botIds = Array.from({ length: 8 }, (_, i) => `lwbot-${i}`);
    const centroid = (): { x: number; y: number } => {
      let x = 0, y = 0, n = 0;
      for (const id of botIds) {
        const p = room.getBotPose(id);
        if (p) { x += p.x; y += p.y; n++; }
      }
      return n > 0 ? { x: x / n, y: y / n } : { x: 0, y: 0 };
    };
    const maxFollowerGap = (): number => {
      const lp = room.getBotPose(leaderId);
      if (!lp) return Infinity;
      let m = 0;
      for (const id of botIds) {
        if (id === leaderId) continue;
        const p = room.getBotPose(id);
        if (!p) continue;
        const d = Math.hypot(p.x - lp.x, p.y - lp.y);
        if (d > m) m = d;
      }
      return m;
    };

    const c0 = centroid();
    const gap0 = maxFollowerGap();
    await h.advance(5000); // let the leader cruise + the herd follow + converge
    const c1 = centroid();
    const gap1 = maxFollowerGap();

    // (a) The herd MOVED — it flew as a group, instead of sitting.
    expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeGreaterThan(50);
    // (b) It CONVERGED — the farthest follower is closer to the leader than at
    //     the start. Overdrive cohesion lets stragglers outpace the cruising
    //     leader, so the gap shrinks (the old equal-speed scheme strung out).
    expect(gap1).toBeLessThan(gap0);
  }, 30_000);
});
