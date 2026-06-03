/**
 * Lock for the disconnect-linger → despawn → return-to-virtual-pool path,
 * exercised through the test-only `lingerMs` JoinOption.
 *
 * Intended behaviour: a disconnected ship lingers in the world, and "after
 * a set amount of time they despawn and return entirely to the virtual
 * pool." Production lingers for LIMBO_DISCONNECT_TTL_MS (15 min) — far too
 * long for a test — so `lingerMs` shortens the ownerless-evict timer.
 *
 * Validates:
 *   1. `lingerMs` is honoured (the evict fires in ~1.2 s, not 15 min).
 *   2. On evict the hull leaves the world (`state.ships` drops it).
 *   3. The roster row SURVIVES, flipped to `isActive=false` (returned to the
 *      pool) with the ship's condition (health) and location (pose) frozen
 *      where it was left — so the player can resume it later.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

describe('SectorRoom integration — linger despawn returns the ship to the pool', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a short-lingerMs disconnect evicts the hull and returns the row to the pool, condition + location preserved', async () => {
    const pid = randomUUID();
    const SPAWN_X = 512;
    const SPAWN_Y = -256;

    const client = await harness.connectActive(pid, {
      shipKind: 'fighter',
      spawnX: SPAWN_X,
      spawnY: SPAWN_Y,
      lingerMs: 1200,
    });

    const state = harness.getServerRoom()!.state as SectorState;
    let origId = '';
    for (const [, ship] of state.ships) {
      if (ship.playerId === pid && ship.isActive) {
        origId = ship.shipInstanceId;
        break;
      }
    }
    expect(origId).not.toBe('');
    const store = getPlayerShipStore();
    expect(store.get(origId)).not.toBeNull();

    // Disconnect → the hull lingers (short TTL armed by lingerMs).
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    expect(state.ships.get(origId)!.isActive).toBe(false);

    // The short-TTL ownerless-evict fires in ~1.2 s (NOT the 15-min prod
    // window). If lingerMs were ignored this would time out.
    await harness.events.waitFor(
      { tag: 'ownerless_evicted', where: (d) => d['shipInstanceId'] === origId },
      { timeoutMs: 4000 },
    );

    // The hull has left the world.
    expect(state.ships.get(origId)).toBeUndefined();

    // The roster row survives — returned to the virtual pool (isActive=false)
    // with condition + location frozen where the ship was left.
    const stored = store.get(origId);
    expect(stored).not.toBeNull();
    expect(stored!.isActive).toBe(false);
    expect(stored!.health).toBeGreaterThan(0);
    expect(Math.abs(stored!.lastX - SPAWN_X)).toBeLessThan(50);
    expect(Math.abs(stored!.lastY - SPAWN_Y)).toBeLessThan(50);
  });
});
