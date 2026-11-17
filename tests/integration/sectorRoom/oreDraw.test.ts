/**
 * Mining-laser ore through the REAL room (owner 2026-11-17: all mined ore
 * arrives as ore pods). A mining-laser hit on a whole rock pays NO ore into
 * the shooter's hold: it only cuts. The rock's pool stays whole until it
 * breaks, is shared out to its pieces by area, and the pieces' ore pods carry
 * it (`OreDraw.cutYield`). Ordinary guns neither mine nor cut.
 *
 * The pilot flies a fighter whose latent wing mount carries the mining laser
 * (seeded on the roster + live hull), locks the rock (`lockTarget`) and fires
 * through the real `fire` message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getHoldStore, getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';

const WRECK_KIND = 4;

describe('SectorRoom integration — mining-laser ore arrives only as ore pods', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  async function setup(radius: number): Promise<{ cr: ClientRoom<SectorState>; room: SectorRoom; pid: string; shipId: string; rockId: string }> {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true })) as ClientRoom<SectorState>;
    const room = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [id, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = id;
    expect(shipId).not.toBe('');
    expect(room._internals.spawnTestAsteroid('rock-1', 0, 400, radius)).toBe(true);
    await harness.advance(100);
    return { cr, room, pid, shipId, rockId: 'rock-1' };
  }

  const holdTotal = (id: string): number => Object.values(getHoldStore().get(id)?.hold.goods ?? {}).reduce((a, n) => a + (n ?? 0), 0);

  it('a real mining-laser fire on a whole rock: the hold does not rise and the rock keeps its whole pool', { timeout: 40_000 }, async () => {
    const { cr, room, pid, shipId, rockId } = await setup(260);
    const rock = room._internals.swarmRegistry.get(rockId)!;
    const pool0 = rock.resources!;
    expect(pool0).toBeGreaterThan(0);
    const mounts = [{ slotId: 'latent-wing-l', weaponId: 'mining_laser' as const }];
    getPlayerShipStore().setProgress(shipId, { mounts });
    room.state.ships.get(shipId)!.mounts = mounts;
    harness.lockTarget(pid, rockId);
    await harness.advance(100);
    let tick = 100;
    const end = Date.now() + 2_500;
    while (Date.now() < end) {
      cr.send('fire', { type: 'fire', tick, clientShotId: `f${tick}`, weapon: 'hitscan', dirAngle: 0, slotId: 'primary' });
      tick += 10;
      await harness.advance(100);
    }
    await harness.advance(1_200); // past a 1 Hz pulse
    expect(room._internals.wreckIntegrity(rockId), 'the beam did hit (and wear) the rock').toBeGreaterThan(0);
    expect(room._internals.swarmRegistry.get(rockId), 'still whole').not.toBeNull();
    expect(rock.resources, 'the laser drew nothing from the pool').toBe(pool0);
    expect(holdTotal(shipId), 'no ore per hit').toBe(0);
  });

  it('cut to the last sliver, the pods carry the rock\'s full ore and nothing reaches the hold on the way', { timeout: 40_000 }, async () => {
    const { room, pid, shipId, rockId } = await setup(60);
    const int = room._internals;
    int.setWreckSeed(9);
    const pool0 = int.swarmRegistry.get(rockId)!.resources!;
    // Synchronous hits, a pulse after each batch: never a hold commit.
    let hits = 0;
    while (int.swarmRegistry.get(rockId) !== null && hits < 400) {
      int.applyDamage(rockId, pid, 120, 6, 340, 0, 1, 'mining_laser');
      if (++hits % 6 === 0) int.pulseStructureGrid();
      if (int.swarmRegistry.get(rockId) !== null) expect(int.swarmRegistry.get(rockId)!.resources).toBe(pool0);
    }
    expect(int.swarmRegistry.get(rockId), 'the rock broke').toBeNull();
    // Grind every piece down to its pod.
    const size = (id: string): number => int.wreckIntegrity(id) ?? 0;
    for (let i = 0; i < 400; i++) {
      const live = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
      if (live.length === 0) break;
      const p = int.wreckState(live[0]!.id);
      if (p) int.applyDamage(live[0]!.id, pid, size(live[0]!.id) + 1, p.x - 1, p.y, 1, 0, 'mining_laser');
      int.pulseStructureGrid();
      await harness.advance(20);
    }
    expect([...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).length, 'every piece ground to pods').toBe(0);
    expect(holdTotal(shipId), 'nothing went straight into the hold').toBe(0);
    let podOre = 0, pods = 0;
    for (const id of int.loot.podIds()) {
      pods++;
      podOre += Object.values(int.loot.shipHold(id)?.goods ?? {}).reduce((a, n) => a + (n ?? 0), 0);
    }
    console.log(`[oreDraw] rock pool ${pool0}; ${pods} pods carry ${podOre}`);
    expect(pods).toBeGreaterThan(0);
    // Each pod rounds its share to whole units: at most half a unit off per pod.
    expect(Math.abs(podOre - pool0), 'the pods carry the rock\'s full ore').toBeLessThanOrEqual(pods / 2);
  });
});
