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

const KIND = SHIP_KINDS_LIST[0]!.id;

describe('LivingWorldDirector — multi-sector population control', () => {
  let h: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  it('spreads bots evenly across all sectors when nobody is online', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime', 'orion-belt', 'vega-reach'], // mutually adjacent
      botCount: 6,
      seed: 7,
    });
    await h.waitUntil(() => {
      const s = h!.director.snapshot();
      return (
        s.active === 6 &&
        s.perSector['sol-prime']!.bots === 2 &&
        s.perSector['orion-belt']!.bots === 2 &&
        s.perSector['vega-reach']!.bots === 2
      );
    }, 8000, 'even 2/2/2 spread');

    const s = h.director.snapshot();
    expect(s.total).toBe(6);
    expect(s.active).toBe(6);
  }, 20_000);

  it('funnels bots toward the sector a player is in', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime', 'orion-belt'], // direct neighbours (1-hop)
      botCount: 4,
      seed: 3,
    });
    // Settle the empty-galaxy spread first.
    await h.waitUntil(() => h!.director.snapshot().active === 4, 6000, 'all 4 active');

    await h.connectActive(randomUUID(), 'orion-belt', { shipKind: KIND });

    await h.waitUntil(() => {
      const s = h!.director.snapshot();
      return s.perSector['orion-belt']!.bots === 4 && s.perSector['sol-prime']!.bots === 0;
    }, 10_000, 'all bots funnelled to the player sector');

    // No bot was lost or duplicated by the cross-room hops.
    expect(h.director.snapshot().active).toBe(4);
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

  // Regression lock for the warp-churn the user reported from phone
  // smoke-testing: "it gets worse the more ships in the sector … fine
  // until more warp in … it's pretty consistent." Diagnostic capture
  // diag/captures/2026-05-16T19-31-00-012Z-q272do: a clean-network
  // session (rtt 0, drift 0) whose population.ndjson showed the SAME bot
  // IDs cycling out of and back into the player's sector on a rigid
  // ~1.5 s cadence, with a `disconnected {code:4000}` + rejoin mid-
  // capture. Root cause: `computeDesiredDistribution` flips from "all
  // bots to the player's sector" to "even 7-way spread" the instant
  // `playerCount()` reads 0, and a mobile connection flap drops it to 0
  // for a few seconds — so the whole pack evacuates then re-funnels,
  // each leg a periodic warp burst. The fix is `playerStickyMs`
  // occupancy hysteresis in the director. The bug LIVES in the
  // director's stateful tick loop reacting to a transient `playerCount`,
  // crossing the real onLeave→playerCount→director seam — hence an
  // integration test at this level, not a pure-math unit test (the pure
  // `computeDesiredDistribution` is stateless and correct per-call).
  it('does NOT evacuate the pack when the player connection briefly flaps', async () => {
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime', 'orion-belt'], // direct neighbours (1-hop)
      botCount: 4,
      seed: 3,
    });
    // Settle the empty-galaxy spread, then funnel everything to the
    // player's sector and let every in-flight hop land.
    await h.waitUntil(() => h!.director.snapshot().active === 4, 6000, 'all 4 active');
    const room = await h.connectActive(randomUUID(), 'sol-prime', { shipKind: KIND });
    await h.waitUntil(() => {
      const s = h!.director.snapshot();
      return (
        s.perSector['sol-prime']!.bots === 4 &&
        s.perSector['orion-belt']!.bots === 0 &&
        s.inTransit === 0
      );
    }, 10_000, 'pack fully funnelled + settled in the player sector');

    // Scope the assertion window to AFTER the funnel: any sol-prime
    // departure from here on is pure churn.
    h.events.clear();

    // The mobile flap: client drops (onLeave → lingering hull,
    // isActive=false → playerCount()===0), a few control ticks pass with
    // the sector reading empty, then the same player reconnects. 300 ms
    // ≈ 5 control ticks (controlIntervalMs 60) — well inside the 2000 ms
    // harness playerStickyMs, so the fix must absorb it completely.
    await h.disconnectClient(room);
    await h.advance(300);
    await h.connectActive(randomUUID(), 'sol-prime', { shipKind: KIND });
    await h.advance(300);

    // The pack must have stayed put. On pre-fix code the disconnect
    // flips the desired distribution to an even spread and the planner
    // streams bots sol-prime→orion-belt at maxMigrationsPerTick — so
    // this count is ≥1 and the snapshot shows a drained sol-prime.
    expect(
      h.events.count({
        tag: 'bot_transit_start',
        where: (d) => d['from'] === 'sol-prime',
      }),
    ).toBe(0);
    const s = h.director.snapshot();
    expect(s.active).toBe(4); // no bot lost or duplicated by the flap
    expect(s.perSector['sol-prime']!.bots).toBe(4); // pack never evacuated
  }, 30_000);

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
