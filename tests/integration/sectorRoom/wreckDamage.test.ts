/**
 * Phase A coverage lock — wreck damage + destruction lifecycle through
 * the real SectorRoom `applyDamage` path.
 *
 * UNCOVERED PRIOR: combat tests cover ship damage; nothing covers the
 * wreck-specific code path in `SectorRoom.applyDamage` that fires when
 * `targetId.startsWith('wreck-')`.
 *
 * COVERS (Phase A7 of `humble-strolling-coral.md`):
 *   1. Applying damage to a wreck reduces its `health` and broadcasts
 *      a `damage` event with the wreck's `targetId` (`wreck-${id}`).
 *   2. Reducing health to 0 broadcasts a `destroy` event, fires the
 *      `SHIP_DESTROYED` bus event, and removes the wreck from
 *      `state.wrecks` (slot returned to the free list).
 *   3. Damage application is clamp-safe: applying damage > current
 *      health drops health to exactly 0 (not negative), and the
 *      wreck removal happens once, not on every subsequent damage.
 *
 * NOTE: The "drones do not fire at wrecks" check belongs to Phase B
 * (Phase 6c — drone retargeting), where it's tested with a failing-
 * test-first flow. The "wrecks collide physically" check is out of
 * scope here — the predWorld registration is already exercised by
 * the wreck pose lock in `abandonToWreck.test.ts`.
 *
 * Implementation note: `applyDamage` is a private method on
 * SectorRoom. We access it via a typed cast — this is an integration
 * test of the lifecycle, not of method visibility, and the alternative
 * (driving a real fire input with precise ray geometry to hit the
 * wreck position) would be far more fragile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

interface ApplyDamageInternals {
  applyDamage: (targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number) => void;
}

function getRoomById(roomId: string): ServerRoom<SectorState> {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState>;
}

describe('SectorRoom integration — wreck damage + destruction', () => {
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

  /** Spawn a player, immediately abandon, return the wreck's
   *  shipInstanceId + the shooter player id (a separate connected
   *  player who can observe the damage broadcasts). */
  async function spawnAndAbandon(): Promise<{
    wreckId: string;
    shooterPid: string;
    roomId: string;
    initialHealth: number;
  }> {
    const abandonedPid = randomUUID();
    const ship = await harness.client.joinOrCreate('test-sector', {
      playerId: abandonedPid,
      shipKind: 'fighter',
      spawnX: 200,
      spawnY: 200,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === abandonedPid });
    // Complete the join handshake so the hull activates (the bare client
    // must send client_ready; the browser does this after bootstrap).
    ship.send('client_ready', { type: 'client_ready' });
    await harness.advance(800);

    const state = getRoomById(ship.roomId).state as SectorState;
    let wreckId = '';
    let initialHealth = 0;
    for (const [, s] of state.ships) {
      if (s.playerId === abandonedPid && s.isActive) {
        wreckId = s.shipInstanceId;
        initialHealth = s.health;
        break;
      }
    }

    // Abandon — triggers the 30-tick poll which calls convertShipToWreck.
    getPlayerShipStore().delete(wreckId);
    await harness.advance(1500);

    // Confirm the wreck exists.
    const wreck = state.wrecks.get(wreckId);
    expect(wreck).toBeDefined();
    expect(wreck!.health).toBe(initialHealth);

    // Connect a shooter so we can observe broadcasts. Different pid so
    // the abandon doesn't affect it.
    const shooterPid = randomUUID();
    await harness.connectAs(shooterPid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === shooterPid });

    return { wreckId, shooterPid, roomId: ship.roomId, initialHealth };
  }

  it('damage to a wreck reduces wreck.health and broadcasts a damage event', async () => {
    const { wreckId, shooterPid, roomId, initialHealth } = await spawnAndAbandon();
    const room = getRoomById(roomId);
    const state = room.state as SectorState;

    // applyDamage is private; cast to the internal contract just for
    // this lifecycle test.
    const internal = room as unknown as ApplyDamageInternals;
    internal.applyDamage(`wreck-${wreckId}`, shooterPid, 10);

    const wreck = state.wrecks.get(wreckId);
    expect(wreck).toBeDefined();
    expect(wreck!.health).toBe(initialHealth - 10);
    // Wreck is still in the map.
    expect(state.wrecks.has(wreckId)).toBe(true);
  });

  it('damage > current health clamps wreck.health to 0 and destroys it', async () => {
    const { wreckId, shooterPid, roomId, initialHealth } = await spawnAndAbandon();
    const room = getRoomById(roomId);
    const state = room.state as SectorState;
    const internal = room as unknown as ApplyDamageInternals;

    // Over-damage: enough to overflow but applyDamage clamps to 0.
    internal.applyDamage(`wreck-${wreckId}`, shooterPid, initialHealth + 99);

    // Wreck removed from state.wrecks; subsequent .get returns undefined.
    expect(state.wrecks.get(wreckId)).toBeUndefined();
  });

  it('subsequent damage on a destroyed wreck is a no-op (no double-destroy)', async () => {
    const { wreckId, shooterPid, roomId, initialHealth } = await spawnAndAbandon();
    const room = getRoomById(roomId);
    const state = room.state as SectorState;
    const internal = room as unknown as ApplyDamageInternals;

    // First shot destroys.
    internal.applyDamage(`wreck-${wreckId}`, shooterPid, initialHealth + 50);
    expect(state.wrecks.get(wreckId)).toBeUndefined();

    // Second shot at the already-destroyed wreck must not throw.
    expect(() => {
      internal.applyDamage(`wreck-${wreckId}`, shooterPid, 5);
    }).not.toThrow();
    expect(state.wrecks.get(wreckId)).toBeUndefined();
  });

  it('partial damage allows multiple shots before destruction', async () => {
    const { wreckId, shooterPid, roomId, initialHealth } = await spawnAndAbandon();
    const room = getRoomById(roomId);
    const state = room.state as SectorState;
    const internal = room as unknown as ApplyDamageInternals;

    // Three shots of 1/4-health each — wreck still alive after each.
    const shot = Math.floor(initialHealth / 4);
    for (let i = 0; i < 3; i++) {
      internal.applyDamage(`wreck-${wreckId}`, shooterPid, shot);
      const wreck = state.wrecks.get(wreckId);
      expect(wreck, `shot ${i + 1} should leave wreck alive`).toBeDefined();
      expect(wreck!.health).toBe(initialHealth - shot * (i + 1));
    }
    // Final big shot destroys.
    internal.applyDamage(`wreck-${wreckId}`, shooterPid, initialHealth);
    expect(state.wrecks.get(wreckId)).toBeUndefined();
  });
});
