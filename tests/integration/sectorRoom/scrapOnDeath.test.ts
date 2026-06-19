/**
 * Scrap-on-death (Phase 2b-ii) — integration lock for invariant #13's "the bug
 * lives at the death → ScrapSpawner → swarm-registry seam".
 *
 * The ScrapSpawner decision logic (transform, velocity, FIFO cap) is unit-locked
 * in src/server/spawn/ScrapSpawner.test.ts. THIS test drives the full server
 * chain: applyDamage → DamageRouter → swarm death policy (createSwarmDeath) →
 * spawnScrapFromDrone → ScrapSpawner.spawnFromDeath → SwarmSpawner.spawnScrap →
 * the swarm registry, through the REAL room.
 *
 * Asserts:
 *  - a destroyed COMPOSITE drone (havok) leaves one DAMAGEABLE scrap piece per
 *    component (7), tagged with the parent ship-kind;
 *  - a destroyed POLYGON drone (fighter) leaves NO scrap;
 *  - a destroyed scrap piece is itself removed and does NOT recursively shatter
 *    into more scrap (the anti-recursion guard).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { shipScrapGroups } from '../../../src/core/geometry/shipScrapGroups.js';
import { SCRAP_HP } from '../../../src/core/swarm/scrapConstants.js';
import { SWARM_KIND_SCRAP } from '../../../src/shared-types/swarmWireFormat.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('SectorRoom integration — scrap-on-death (Phase 2b-ii)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  function scrapRecs(internal: SectorRoom['_internals']) {
    return [...internal.swarmRegistry.all()].filter((r) => r.kind === SWARM_KIND_SCRAP);
  }

  it('a destroyed COMPOSITE drone breaks into one damageable scrap piece per component', async () => {
    const shooter = randomUUID();
    const cr = await harness.connectActive(shooter, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooter });
    const internal = getRoomById(cr.roomId)._internals;

    // Seed a composite (havok) drone, hull exposed (shield 0) so one hit kills it.
    expect(internal.spawnTestDrone('havok-drone', 600, 0, 'havok')).toBe(true);
    expect(internal.swarmRegistry.get('havok-drone')).toBeTruthy();
    expect(scrapRecs(internal)).toHaveLength(0);

    const expectedPieces = shipScrapGroups('havok').length;
    expect(expectedPieces).toBe(7);

    // Kill the drone (the EntityResolver swarm branch resolves by the registry id).
    internal.applyDamage('havok-drone', shooter, 9999);

    // Parent gone; one scrap piece per component, each damageable + parent-tagged.
    expect(internal.swarmRegistry.get('havok-drone')).toBeFalsy();
    const scrap = scrapRecs(internal);
    expect(scrap).toHaveLength(expectedPieces);
    for (const s of scrap) {
      expect(s.shipKind).toBe('havok');
      expect(internal.swarmHealth.get(s.id)).toBe(SCRAP_HP);
    }
  });

  it('a destroyed POLYGON-kind drone leaves no scrap', async () => {
    const shooter = randomUUID();
    const cr = await harness.connectActive(shooter, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooter });
    const internal = getRoomById(cr.roomId)._internals;

    expect(internal.spawnTestDrone('fighter-drone', 600, 0, 'fighter')).toBe(true);
    internal.applyDamage('fighter-drone', shooter, 9999);

    expect(internal.swarmRegistry.get('fighter-drone')).toBeFalsy();
    expect(scrapRecs(internal)).toHaveLength(0);
  });

  it('a destroyed scrap piece is removed and does NOT shatter into more scrap', async () => {
    const shooter = randomUUID();
    const cr = await harness.connectActive(shooter, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooter });
    const internal = getRoomById(cr.roomId)._internals;

    internal.spawnTestDrone('havok-drone', 600, 0, 'havok');
    internal.applyDamage('havok-drone', shooter, 9999);
    const scrap = scrapRecs(internal);
    expect(scrap.length).toBe(7);

    // Destroy ONE scrap piece (it's damageable, SCRAP_HP). It must vanish and
    // NOT spawn a fresh batch of scrap (anti-recursion guard).
    const victim = scrap[0]!.id;
    internal.applyDamage(victim, shooter, SCRAP_HP + 50);

    expect(internal.swarmRegistry.get(victim)).toBeFalsy();
    expect(scrapRecs(internal)).toHaveLength(6); // 7 - 1, no recursive re-spawn
  });

  it('a DOUBLE SHIP_DESTROYED on the same active hull does NOT crash the registry (idempotent shatter)', async () => {
    // 2026-06-19 playtest crash: two lethal wave hits landed in ONE tick, so
    // SHIP_DESTROYED fired TWICE for the same hull → the scrap block re-spawned
    // the same scrap ids → `SwarmEntityRegistry.register` threw "id already
    // registered" and took the whole server down. The fix makes scrap spawning
    // idempotent (skip a duplicate id). This reproduces the double-fire directly
    // via the bus (the same-tick double-cross), at the level where the bug lives.
    const shooter = randomUUID();
    const victim = randomUUID();
    // A COMPOSITE player hull so death actually shatters into scrap.
    const cr = await harness.connectActive(victim, { shipKind: 'havok' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === victim });
    const room = getRoomById(cr.roomId);
    const internal = room._internals;
    const before = scrapRecs(internal).length;
    const pieces = shipScrapGroups('havok').length;
    expect(pieces).toBeGreaterThan(0);

    const evt = { type: 'SHIP_DESTROYED' as const, targetId: victim, shooterId: shooter };
    room.eventBus().emit('SHIP_DESTROYED', evt);
    // The SECOND identical emit must be a no-op, NOT a registry crash.
    expect(() => room.eventBus().emit('SHIP_DESTROYED', evt)).not.toThrow();

    // Exactly ONE component-set of scrap — the duplicate shatter was skipped.
    expect(scrapRecs(internal).length - before).toBe(pieces);
  });
});
