/**
 * Smoke-test bug (Pixel 7 film): a new account's Mining Skiff parks ~170 u
 * from a size-32 rock's centre, taps the rock and presses the card's
 * "LOCK · MINING LASER". The laser group shows a lock, yet over 60 s nothing
 * reaches the hold and the card still offers LOCK.
 *
 * Cause: the hands-off card locks only the ACTIVE group. The laser locked and
 * made its first cut, but every piece was one the Skiff's S tractor can pull,
 * which the laser leaves for the tractors; the tractor group (AUTO) never
 * picks a rock or piece by itself, and pieces can't be tapped. So the rock
 * sat cut once and the hold stayed empty.
 *
 * Through the REAL room: only the card's `lock_request` on the laser group
 * (no `instantLock`, the real lock timing), every group in its default mode,
 * and the client's AUTO fire pass stood in by a `fire` for each group holding
 * a LOCKED target.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { ROCK_CHUNK_PRODUCT } from '../../../src/shared-types/items.js';

const SPEED = 4;
const BUDGET_GAME_S = 60;

describe('SectorRoom integration — skiff hands-off rock lock', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a hands-off laser lock on a size-32 rock 170 u away puts rock chunks in the hold', { timeout: 120_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [], timeScale: SPEED, subcapWrecks: true,
    });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, { shipKind: 'mining-skiff', spawnX: 0, spawnY: 0 })) as ClientRoom<SectorState>;
    for (const t of ['hit_ack', 'laser_fired', 'swarm', 'damage', 'destroy', 'loot_collected', 'collision_resolved', 'snapshot']) cr.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    const chunks = (): number =>
      (getHoldStore().get(ship.shipInstanceId)?.hold.packed ?? []).filter((p) => p.product === ROCK_CHUNK_PRODUCT).length;

    expect(int().spawnTestAsteroid('rock-32', 0, 170, 32)).toBe(true);
    const key = `s:${int().swarmRegistry.get('rock-32')!.entityId}`;
    await harness.advance(100);

    // The card: LOCK · MINING LASER (the active group only).
    cr.send('lock_request', { type: 'lock_request', groupId: 'laser', target: key });
    let shot = 0;
    const tick0 = int().serverTick;
    while (int().serverTick - tick0 < BUDGET_GAME_S * 60 && chunks() === 0) {
      for (const g of int().locksOf(pid) ?? []) {
        if (g.l.some((l) => l.s === 2)) {
          cr.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: `l${shot++}`, weapon: 'hitscan', dirAngle: 0, slotId: g.id });
        }
      }
      await harness.advance(10);
    }
    console.log(`[skiffHandsOff] chunks ${chunks()} after ${((int().serverTick - tick0) / 60).toFixed(1)} s; groups ${JSON.stringify(int().locksOf(pid))}`);
    expect(chunks(), 'a rock chunk reaches the hold').toBeGreaterThan(0);
  });
});
