/**
 * Integration coverage for the LivingWorldDirector across a real
 * multi-room galaxy (one SectorRoom + physics worker per sector) wired to
 * a live director with a seeded RNG + tiny timings.
 *
 * This is the level the director's behaviour LIVES at: cross-room
 * population control, real swarm spawn/despawn, real bus events. The pure
 * distribution/migration math is unit-tested separately
 * (population.test.ts); the SectorRoom hooks in livingWorldHooks.test.ts.
 *
 * Faithful-kill note: a real combat kill is `evictSwarmEntity` (removal)
 * + an `ENTITY_DESTROYED` bus emit, atomically. The director only ever
 * observes the bus event, so the respawn / shed tests reproduce that
 * signal by removing the bot via the quiet hook and then emitting the
 * event the director actually subscribes to — exercising the director
 * contract without a production-only test seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { SHIP_KINDS_LIST } from '../../../src/shared-types/shipKinds.js';
import { isEntrySector } from '../../../src/core/galaxy/galaxy.js';

const KIND = SHIP_KINDS_LIST[0]!.id;

describe('LivingWorldDirector — multi-sector population control', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('seeds a squad at an ENTRY (edge) sector — never the interior (drone-warp-in invariant)', async () => {
    // Entry-only ingress: bots materialise ONLY at entry (edge) sectors and
    // gather at their squad's home edge until a wave is declared. In this live
    // set the only galaxy ENTRY sector is greenfall (the Verdant frontier);
    // emerald-span + verdance are interior — NO drone may appear there out of
    // nowhere. The single squad homes at the entry (greenfall).
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span', 'verdance'],
      botCount: 6,
      seed: 7,
    });
    await h.waitUntil(() => h!.director.snapshot().active === 6, 8000, 'all 6 warped in');

    // THE invariant: every from-nowhere spawn (`bot_spawn`) is at an entry
    // sector, and NONE at the interior sol-prime.
    const spawns = h.events.all({ tag: 'bot_spawn' });
    expect(spawns.length).toBeGreaterThanOrEqual(6);
    for (const e of spawns) {
      expect(isEntrySector(e.data['sectorKey'] as string)).toBe(true);
      expect(e.data['sectorKey']).not.toBe('sol-prime');
    }
    // The squad gathered at its home edge; no member ingressed into the centre.
    const s = h.director.snapshot();
    expect(s.perSector['verdance']!.bots).toBe(0);
    expect(s.perSector['greenfall']!.bots).toBe(6);
  }, 20_000);

  it('does NOT hunt a player who has no base (Req #6 — occupancy aggro retired)', async () => {
    // The single most important regression lock for the wave refactor: a player
    // flying through a sector is NOT enough to trigger drones. Only a wave
    // declared against a READY base aggros them. With no structures the squad
    // must never enter `warping`/`attacking`.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 4,
      seed: 3,
    });
    // greenfall is the only entry sector in this set, so the squad gathers there.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 4,
      6000,
      'squad gathered at its home edge',
    );
    // Player joins the OTHER sector (no base, no structures) as a fully ACTIVE
    // hull (connectActive sends client_ready so playerCount() counts it — the
    // no-hunt guarantee must hold for a real, present player).
    await h.connectActive(randomUUID(), 'emerald-span', { shipKind: KIND });
    await h.advance(600); // ~10 control ticks at the harness interval

    // Load-bearing: no wave was ever declared against the base-less player — the
    // squad never left idle/forming (this assertion survives roaming, which
    // keeps idle squads in the `idle` state). And no drone ingressed into the
    // player's interior sector.
    const sq = h.director.squadSnapshot();
    expect(sq.byState.warping).toBe(0);
    expect(sq.byState.attacking).toBe(0);
    const s = h.director.snapshot();
    expect(s.active).toBe(4);
    expect(s.perSector['emerald-span']!.bots).toBe(0);
  }, 25_000);

  it('roams an idle squad across the graph (HOP, not ingress) — and stays neutral', async () => {
    // Roaming replaces the retired ambient patrol floor: an idle, unassigned
    // squad gathers at its home edge (greenfall, the Verdant entry), then
    // slow-drifts the graph. greenfall's only live neighbour is emerald-span, so
    // the squad drifts inward — proving roaming reaches interior sectors via real
    // HOPS (bot_transit_commit), NOT from-nowhere ingress, and never goes hostile.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8,
      seed: 11,
      director: { roamIntervalMs: 100, hopTravelMs: 40 },
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['greenfall']!.bots === 8,
      6000,
      'squad gathered at its home edge',
    );
    // The squad drifts inward to emerald-span within a roam cycle.
    await h.waitUntil(
      () => h!.director.snapshot().perSector['emerald-span']!.bots > 0,
      6000,
      'a member roamed into the interior via a hop',
    );

    // Reaching the interior was a HOP (despawn→spawn pair, logged
    // bot_transit_commit), NEVER a from-nowhere ingress: every bot_spawn is at
    // the entry edge.
    const intoInterior = h.events.all({
      tag: 'bot_transit_commit',
      where: (d) => d['to'] === 'emerald-span',
    });
    expect(intoInterior.length).toBeGreaterThan(0);
    for (const e of h.events.all({ tag: 'bot_spawn' })) {
      expect(isEntrySector(e.data['sectorKey'] as string)).toBe(true);
    }
    // Roaming squads stay NEUTRAL — never warping/attacking (hostility is
    // wave-only).
    const sq = h.director.squadSnapshot();
    expect(sq.byState.warping).toBe(0);
    expect(sq.byState.attacking).toBe(0);
  }, 25_000);

  it('respawns a combat-killed bot from no-origin after the delay', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime'],
      botCount: 2,
      seed: 5,
      director: { respawnDelayMs: 250 },
    });
    await h.waitUntil(() => h!.director.snapshot().active === 2, 6000, 'both bots active');

    const room = h.getRoom('sol-prime');
    const carry = room.despawnLivingWorldBot('lwbot-0'); // remove …
    expect(carry).not.toBeNull();
    room.eventBus().emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'lwbot-0' }); // … then the kill signal

    await h.waitUntil(() => h!.director.snapshot().active === 1, 3000, 'killed bot leaves the world');
    await h.waitUntil(() => h!.director.snapshot().active === 2, 4000, 'bot warps back in');

    const s = h.director.snapshot();
    expect(s.total).toBe(2);
    expect(s.respawning).toBe(0);
  }, 20_000);

  it('shed-and-pauses under load, refilling only once sheds stop', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime'],
      botCount: 2,
      seed: 9,
      director: { shedRecoveryMs: 500, respawnDelayMs: 20 },
    });
    await h.waitUntil(() => h!.director.snapshot().active === 2, 6000, 'both bots active');

    const room = h.getRoom('sol-prime');
    expect(room.despawnLivingWorldBot('lwbot-0')).not.toBeNull();
    room.eventBus().emit('ENTITY_SHED', { type: 'ENTITY_SHED', entityId: 'lwbot-0' });

    await h.waitUntil(() => h!.director.snapshot().active === 1, 2000, 'shed bot leaves');

    // While sheds are still "fresh" the director must NOT refill (it
    // cooperates with TiDi instead of fighting the shedder).
    await h.advance(250); // < shedRecoveryMs (500)
    expect(h.director.snapshot().active).toBe(1);

    // Once no further sheds for shedRecoveryMs, the population refills.
    await h.waitUntil(() => h!.director.snapshot().active === 2, 3000, 'refill after recovery');
    expect(h.director.snapshot().total).toBe(2);
  }, 20_000);
});
