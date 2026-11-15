/**
 * Ore draw (plan partitioned-chasing-lark PR 8) through the REAL room: a
 * mining-laser hit on an asteroid owes the shooter ore, and the 1 Hz grid
 * pulse pays it out through the one mining path (`SectorRoom.mineAsteroid` →
 * `drawAsteroidResources`): the rock's pool drops by exactly what lands in the
 * shooter's hold. Ordinary guns do not mine.
 *
 * The pilot flies a fighter whose latent wing mount carries the mining laser
 * (seeded on the roster + live hull: no ship carries it yet, and the
 * `activate_mount` upgrade does not offer it), locks the rock (`lockTarget`)
 * and fires through the real `fire` message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages/snapshotMessages.js';
import { getHoldStore, getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { ORE_UNITS_PER_DAMAGE } from '../../../src/server/rooms/OreDraw.js';

describe('SectorRoom integration — mining-laser ore draw (salvage PR 8)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function setup(): Promise<{ cr: ClientRoom<SectorState>; room: SectorRoom; pid: string; shipId: string; rockId: string }> {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true })) as ClientRoom<SectorState>;
    const room = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = id;
    expect(shipId).not.toBe('');
    expect(room._internals.spawnTestAsteroid('rock-1', 0, 400, 60)).toBe(true);
    await harness.advance(100);
    return { cr, room, pid, shipId, rockId: 'rock-1' };
  }

  const minerals = (shipId: string): number => getHoldStore().get(shipId)?.hold.goods.minerals ?? 0;

  /** Fire the pilot's guns for `ms` (a `fire` every 100 ms, client ticks 10 apart). */
  async function fireFor(cr: ClientRoom<SectorState>, ms: number, tick0: number): Promise<number> {
    let tick = tick0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      cr.send('fire', { type: 'fire', tick, clientShotId: `f${tick}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
      tick += 10;
      await harness.advance(100);
    }
    return tick;
  }

  it('the mining laser on a locked rock fills the hold by exactly what the rock lost; guns alone do not mine', { timeout: 40_000 }, async () => {
    const { cr, room, pid, shipId, rockId } = await setup();
    const rock = room._internals.swarmRegistry.get(rockId)!;
    const pool0 = rock.resources!;
    expect(pool0).toBeGreaterThan(0);

    // Guns only (the fighter's own lasers): the rock is hit, no ore moves.
    harness.lockTarget(pid, rockId);
    const tick = await fireFor(cr, 1_500, 0);
    await harness.advance(1_200); // at least one pulse
    expect(rock.resources, 'guns do not mine').toBe(pool0);
    expect(minerals(shipId)).toBe(0);

    // Fit the mining laser on the latent wing mount, lock the rock again, fire ~2 s.
    const mounts = [{ slotId: 'latent-wing-l', weaponId: 'mining_laser' as const }];
    getPlayerShipStore().setProgress(shipId, { mounts });
    room.state.ships.get(shipId)!.mounts = mounts;
    harness.lockTarget(pid, rockId);
    await harness.advance(100);
    await fireFor(cr, 2_000, tick + 100);
    await harness.advance(1_200); // the last owed ore lands on the next pulse
    const lost = pool0 - rock.resources!;
    expect(lost, 'the mining laser drew ore from the rock').toBeGreaterThan(0);
    expect(minerals(shipId), 'every unit the rock lost is in the hold (rock → minerals 1:1)').toBe(lost);

    // The hold reaches the pilot on the own-ship snapshot slice (#16).
    harness.sendThrust(cr);
    let seen = 0;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && seen < lost) {
      const snap: SnapshotMessage = await harness.waitForSnapshot(cr, 2_000);
      seen = snap.states?.[shipId]?.cargo?.goods['minerals'] ?? seen;
    }
    expect(seen).toBe(lost);
  });

  it('ore arrives in pulse batches, not per hit', { timeout: 20_000 }, async () => {
    const { room, pid, shipId, rockId } = await setup();
    const int = room._internals;
    const rock = int.swarmRegistry.get(rockId)!;
    const pool0 = rock.resources!;
    // Synchronous: no pulse can run between these lines.
    for (let i = 0; i < 12; i++) int.applyDamage(rockId, pid, 120, undefined, undefined, undefined, undefined, 'mining_laser');
    int.applyDamage(rockId, pid, 120, undefined, undefined, undefined, undefined, 'heavy_beam');
    expect(rock.resources, 'hits only owe ore').toBe(pool0);
    expect(minerals(shipId)).toBe(0);
    int.pulseStructureGrid();
    const drawn = pool0 - rock.resources!;
    expect(drawn, 'one pulse pays out the twelve mining-laser hits (two seconds of beam)').toBe(Math.floor(12 * 120 * ORE_UNITS_PER_DAMAGE));
    expect(minerals(shipId)).toBe(drawn);
    int.pulseStructureGrid();
    expect(rock.resources, 'nothing owed, nothing drawn').toBe(pool0 - drawn);
  });
});
