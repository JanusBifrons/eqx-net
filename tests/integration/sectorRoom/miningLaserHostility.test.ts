/**
 * Mining laser (plan partitioned-chasing-lark PR 7) in a real room: a hit
 * whose per-target factor leaves 0 damage is NOT an attack. `applyDamage`
 * feeds the EFFECTIVE (factored) damage to its side effects (standing,
 * economic hit, NPC hostility refresh, capital `noteHit`), so a mining laser
 * on a raised shield changes nothing, while on an exposed hull it does 5 %
 * and counts as a hit like any other.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector, type TradeRoom } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import { getHoldStore, getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { STANDING_HIT_DELTA } from '../../../src/shared-types/factions.js';
import type { ShipState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — a 0-damage mining laser hit is not an attack', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    setTradeSink(null);
    if (harness) await harness.cleanup();
  });

  it('on a raised shield: no damage, no standing loss; on an exposed hull: 5 % and a normal hit', async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      defaultSpawnX: 0, defaultSpawnY: -1000,
    });
    const store = new EconomyStore({ persistence: getPersistence });
    setTradeSink(new TradeDirector(new Map<string, TradeRoom>(), store, getHoldStore(), { wallet: getWallet() }));
    const miner = randomUUID();
    const shielded = randomUUID();
    const exposed = randomUUID();
    await harness.connectActive(miner);
    await harness.connectActive(shielded);
    await harness.connectActive(exposed);
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const shipOf = (pid: string): ShipState => [...room.state.ships.values()].find((s) => s.playerId === pid)!;

    const a = shipOf(shielded);
    expect(a.shield, 'a fresh hull has its shield up').toBeGreaterThan(0);
    const shield0 = a.shield, hull0 = a.health;
    internals.applyDamage(shielded, miner, 100, undefined, undefined, undefined, undefined, 'mining_laser');
    expect(a.shield).toBe(shield0);
    expect(a.health).toBe(hull0);
    expect(store.standing(shielded, miner), 'a 0-damage hit is not a hostile act').toBe(0);

    const b = shipOf(exposed);
    b.shield = 0;
    const hull1 = b.health;
    internals.applyDamage(exposed, miner, 100, undefined, undefined, undefined, undefined, 'mining_laser');
    expect(b.health).toBeCloseTo(hull1 - 5, 6);
    expect(store.standing(exposed, miner), 'a real (5 %) hit still counts').toBe(STANDING_HIT_DELTA);
  });
});
