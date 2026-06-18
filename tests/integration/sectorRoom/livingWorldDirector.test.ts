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

  it('a dispatched single-squad wave delivers all 8 to the base — cohesion lock (issue 4)', async () => {
    // Phase-1 issue 4: "only 1-2 ships destroyed instead of squads of 8". The
    // existing wave tests only assert attacking>0 / enemies>0, so a wave that
    // delivered a TRICKLE would pass them. This asserts squad COHESION end-to-end:
    // a dispatched squad's 8 members all traverse greenfall→emerald-span and
    // arrive (counting DISTINCT bot ids that committed a hop INTO the base sector
    // — the cumulative arrival signal, immune to the base turret picking arrivals
    // off, which would deflate a simultaneous head-count).
    //
    // FINDING (2026-06-18): this PASSES — single-squad dispatch + traversal is
    // HEALTHY. So the reported "1-2 ships" is NOT a single-squad bug; it's a
    // full-pool CONTENTION / scale or dispatch-cadence symptom (7×8 bots across
    // 21 sectors, 1-squad EscalatingWavePattern, 5-min dispatch interval). Per
    // the doc ("the logs should be revealing") that needs runtime audit-log /
    // contention evidence to fix safely — see the PR description. This test
    // stands as the regression lock that the cohesive single-squad path stays
    // healthy while that investigation continues.
    h = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 8, // one full squad (squad-0)
      seed: 5,
      bases: [
        {
          sector: 'emerald-span',
          owner: 'offline-owner',
          structures: [
            { kind: 'capital', x: 0, y: 0 },
            { kind: 'solar', x: 250, y: 0 },
            { kind: 'miner', x: -350, y: 0 },
            { kind: 'turret', x: 0, y: 350 },
          ],
        },
      ],
      director: { dispatchIntervalMs: 1, controlIntervalMs: 50, spoolMs: 40, hopTravelMs: 40 },
    });

    const distinctArrivals = (): number => {
      const ids = new Set<string>();
      for (const e of h!.events.all({ tag: 'bot_transit_commit', where: (d) => d['to'] === 'emerald-span' })) {
        const id = (e.data['botId'] ?? e.data['id']) as string | undefined;
        if (id) ids.add(id);
      }
      return ids.size;
    };

    // Wait for the wave to reach the base (at least one arrival).
    await h.waitUntil(() => distinctArrivals() > 0, 8000, 'the wave begins arriving at the base');
    // Then give the whole squad time to traverse the single hop.
    await h.waitUntil(() => distinctArrivals() >= 8, 10000, 'the FULL squad of 8 reaches the base');
    expect(distinctArrivals()).toBeGreaterThanOrEqual(8);
  }, 35_000);

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
