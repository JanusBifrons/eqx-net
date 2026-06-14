/**
 * WS-4 (Phase 5) — roaming squads fly in FORMATION inside a sector.
 *
 * Playtest ask: "the intention was for the 'Legionnaire' squads of 8 to fly in
 * formation together INSIDE a sector" (and gather + warp as one unit between
 * sectors). The director's `formationStep` designates a leader, flies the squad
 * toward an arbitrary in-sector A→B destination, and places each follower in a
 * wedge slot relative to the leader — pushed to each bot via the room's
 * `setBotMoveTarget` hook, where the drone's IDLE `HostileDroneBehaviour`
 * arrives at the slot and slows to a stop.
 *
 * This lives at the multi-room director level (the behaviour LIVES here — real
 * squad gather + real room hooks); the pure slot/steer math is unit-tested in
 * src/core/ai/{formation,steering}.test.ts and the behaviour in
 * HostileDroneBehaviour.moveTarget.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';

describe('LivingWorldDirector — in-sector squad formation (WS-4)', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('assigns every gathered idle-squad member a DISTINCT in-sector move target (a wedge, not a clump)', async () => {
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

    // Spy on the formation move-target assignments the director pushes to the
    // room (the director calls this room instance, so shadowing the method
    // records every assignment while still driving the real behaviour).
    const room = h.getRoom('greenfall');
    const calls: Array<{ botId: string; x: number; y: number }> = [];
    const orig = room.setBotMoveTarget.bind(room);
    room.setBotMoveTarget = (botId: string, x: number, y: number): void => {
      calls.push({ botId, x, y });
      orig(botId, x, y);
    };

    // Within a control tick, formationStep assigns every gathered member a
    // target (leader → destination, followers → their wedge slots).
    await h.waitUntil(
      () => new Set(calls.map((c) => c.botId)).size >= 8,
      6000,
      'formation move targets assigned to all 8 members',
    );

    // All 8 members targeted, and the targets are DISTINCT points — proving the
    // wedge slots are placed apart, not stacked at one spot (the "sit there /
    // clump" complaint).
    expect(new Set(calls.map((c) => c.botId)).size).toBe(8);
    const distinctTargets = new Set(calls.map((c) => `${Math.round(c.x)}:${Math.round(c.y)}`));
    expect(distinctTargets.size).toBeGreaterThan(1);
  }, 25_000);
});
