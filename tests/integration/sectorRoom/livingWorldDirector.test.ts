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

  it('seeds a squad into its home sector and HOLDS (no occupancy spread)', async () => {
    // Wave model: bots gather at their squad's home sector and stay put until a
    // wave is declared against a ready base. botCount 6 ⇒ one (partial) squad of
    // 6, whose home is the first sector. They must NOT spread across sectors the
    // way the retired occupancy distribution did.
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime', 'orion-belt', 'vega-reach'],
      botCount: 6,
      seed: 7,
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['sol-prime']!.bots === 6,
      8000,
      'all 6 gathered at the squad home',
    );
    const s = h.director.snapshot();
    expect(s.active).toBe(6);
    expect(s.perSector['orion-belt']!.bots).toBe(0);
    expect(s.perSector['vega-reach']!.bots).toBe(0);
  }, 20_000);

  it('does NOT hunt a player who has no base (Req #6 — occupancy aggro retired)', async () => {
    // The single most important regression lock for the wave refactor: a player
    // flying through a sector is NOT enough to trigger drones. Only a wave
    // declared against a READY base aggros them. With no structures, the squad
    // must never warp toward or aggro the player.
    h = await bootLivingWorldTestServer({
      sectors: ['sol-prime', 'orion-belt'],
      botCount: 4,
      seed: 3,
    });
    await h.waitUntil(
      () => h!.director.snapshot().perSector['sol-prime']!.bots === 4,
      6000,
      'squad gathered at home',
    );
    // Player joins the OTHER sector (no base, no structures).
    await h.connectAs(randomUUID(), 'orion-belt', { shipKind: KIND });
    h.events.clear();
    await h.advance(600); // ~10 control ticks at the harness interval

    // No squad warped toward the player; the pack stayed home.
    expect(h.events.count({ tag: 'bot_transit_start' })).toBe(0);
    const s = h.director.snapshot();
    expect(s.active).toBe(4);
    expect(s.perSector['sol-prime']!.bots).toBe(4);
    expect(s.perSector['orion-belt']!.bots).toBe(0);
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
