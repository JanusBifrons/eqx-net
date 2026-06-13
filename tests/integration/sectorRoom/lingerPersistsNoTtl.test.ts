/**
 * WS-12 / R2.26 — a disconnected ship's hull now PERSISTS in the world FOREVER;
 * there is NO timed despawn.
 *
 * (This file formerly locked the despawn → return-to-pool path. The 15-min
 * ownerless-evict TTL was removed per the user's intent: "the ship persists
 * forever now, it no longer despawns in the world. Wreck mechanic stays the
 * same as before, if you abandon it becomes a wreck." So a lingering hull only
 * leaves the world via combat destruction, the owner resuming a different roster
 * ship, or abandonment → wreck — never on a clock.)
 *
 * Validates (FAILING-FIRST — the pre-R2.26 code armed a `lingerMs`-short
 * ownerless-evict timer that despawned the hull, so these assertions fail on it):
 *   1. A disconnected ship lingers (isActive=false) with a `null` presence
 *      marker (no despawn timer).
 *   2. No `ownerless_evicted` event ever fires for the lingering hull — it STAYS
 *      in the world past the would-be-short lingerMs window.
 *   3. The roster row exists (returned to the virtual pool, isActive=false) so
 *      the player can still resume it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — lingering hulls persist forever (no TTL despawn, R2.26)', () => {
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

  it('a disconnect lingers + PERSISTS past the would-be TTL; the row stays resumable', async () => {
    const pid = randomUUID();
    const SPAWN_X = 512;
    const SPAWN_Y = -256;

    const client = await harness.connectActive(pid, {
      shipKind: 'fighter',
      spawnX: SPAWN_X,
      spawnY: SPAWN_Y,
      // Would-be-short window: on the PRE-R2.26 code this armed a 300 ms
      // ownerless-evict timer that despawned the hull. Under R2.26 it no longer
      // despawns the hull at all (it still bounds the Limbo reconnect-data only).
      lingerMs: 300,
    });

    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
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

    // Disconnect → the hull lingers (isActive=false).
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    expect(state.ships.get(origId)!.isActive).toBe(false);

    // The presence marker exists but carries NO despawn timer (null) — R2.26.
    const ownerless = (room as unknown as SectorRoom)._internals.ownerlessShips;
    expect(ownerless.has(origId)).toBe(true);
    expect(ownerless.get(origId)).toBeNull();

    // THE LOCK: the ownerless-evict NEVER fires. On the pre-R2.26 code the
    // 300 ms timer evicted the hull here; the wait must now TIME OUT (reject).
    await expect(
      harness.events.waitFor(
        { tag: 'ownerless_evicted', where: (d) => d['shipInstanceId'] === origId },
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow();

    // The hull is STILL in the world.
    expect(state.ships.get(origId)).toBeDefined();
    expect(state.ships.get(origId)!.isActive).toBe(false);
    expect(ownerless.has(origId)).toBe(true);

    // The roster row is still there (resumable), condition + location preserved.
    const stored = store.get(origId);
    expect(stored).not.toBeNull();
    expect(stored!.health).toBeGreaterThan(0);
    expect(Math.abs(stored!.lastX - SPAWN_X)).toBeLessThan(50);
    expect(Math.abs(stored!.lastY - SPAWN_Y)).toBeLessThan(50);
  });
});
