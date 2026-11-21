/**
 * The small mining ship (playable base loop job 1D) through the REAL room:
 * the pilot flies the mining skiff in the barge-mining showcase room
 * (roster-backed, so the skiff has a hold), parks it with mine-rock-a dead
 * ahead, locks the rock with its mining laser and its tractors, and holds
 * both triggers. The S laser cuts the rock (a whole rock is tier none: the
 * biggest laser the group has cuts it, `laserCutsTier`), the S tractors pull
 * each piece of tier S or smaller to the hull, and the piece goes into the
 * hold whole as one rock chunk (`LootSubsystem`). Same chain as the barge's
 * take (`bargeMiningTake.test.ts`); the skiff only differs in its mounts.
 *
 * Needs the rock's cut pieces to reach the S tractor's size (tier 2). If the
 * rock split floor (the separate floor PR) is still above that, the laser
 * stops splitting before any piece is pullable and this test fails on the
 * chunk count: that is the floor, not the skiff.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_BARGE_MINING_OPTS } from '../../../src/server/rooms/showcaseBargeRooms.js';
import { TRACTOR_DEF } from '../../../src/core/combat/tractorSpec.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { ROCK_CHUNK_PRODUCT } from '../../../src/shared-types/items.js';

/** Game speed (the sector time scale's top, 4×). */
const SPEED = 4;
const TRACTOR_LEASE = TRACTOR_DEF.tractor!.leaseTicks;
/** The take's game-time budget (s). */
const TAKE_GAME_S = 240;
/** Nose +y: mine-rock-a (1150, 400, r 260) dead ahead, ~440 u from its edge,
 *  inside the laser's arc and the S tractors' reach; clear of mine-rock-b. */
const SPAWN = { spawnX: 1150, spawnY: -300 };

describe('SectorRoom integration — the mining skiff', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('miner cuts a rock and stores a chunk', { timeout: 240_000 }, async () => {
    harness = await bootSectorTestServer({ ...SHOWCASE_BARGE_MINING_OPTS, subcapWrecks: true, timeScale: SPEED });
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'mining-skiff', ...SPAWN, instantLock: true, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    for (const t of ['laser_fired', 'swarm', 'damage', 'destroy', 'hit_ack', 'loot_collected', 'collision_resolved', 'snapshot']) cr.onMessage(t, () => {});
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = (): SectorRoom['_internals'] => room._internals;
    const ship = [...room.state.ships.values()].find((s) => s.playerId === pid)!;
    expect(ship.kind).toBe('mining-skiff');
    const chunks = (): number => (getHoldStore().get(ship.shipInstanceId)?.hold.packed ?? []).filter((p) => p.product === ROCK_CHUNK_PRODUCT).length;
    const minerals0 = (getHoldStore().get(ship.shipInstanceId)?.hold.goods as Record<string, number> | undefined)?.minerals ?? 0;
    expect(int().swarmRegistry.get('mine-rock-a')).toBeTruthy();

    harness.lockTarget(pid, 'mine-rock-a', 'laser');
    harness.lockTarget(pid, 'mine-rock-a', 'tractor');
    let shot = 0;
    const fire = (slotId: string): void => {
      cr.send('fire', { type: 'fire', tick: int().serverTick, clientShotId: `${slotId}${shot++}`, weapon: 'hitscan', dirAngle: 0, slotId });
    };
    let cut = false;
    const pods = new Set<string>();
    const tick0 = int().serverTick;
    while (int().serverTick - tick0 < TAKE_GAME_S * 60 && chunks() === 0) {
      cut ||= int().swarmRegistry.get('mine-rock-a') == null;
      for (const id of int().loot.podIds()) pods.add(id);
      fire('laser'); fire('tractor');
      // Renew inside the tractor lease, in game time.
      const fired = int().serverTick;
      while (int().serverTick - fired < TRACTOR_LEASE / 2) await harness.advance(5);
    }
    cut ||= int().swarmRegistry.get('mine-rock-a') == null;
    console.log(`[miningSkiffTake] ${((int().serverTick - tick0) / 60).toFixed(1)} s game; cut ${cut}; ${chunks()} chunks`);
    expect(cut, 'the skiff laser cuts the rock').toBe(true);
    expect(chunks(), 'a piece goes into the hold as a rock chunk').toBeGreaterThanOrEqual(1);
    expect(pods.size, 'a rock never turns into a pod').toBe(0);
    expect((getHoldStore().get(ship.shipInstanceId)?.hold.goods as Record<string, number> | undefined)?.minerals ?? 0, 'no ore on the way in').toBe(minerals0);
  });
});
