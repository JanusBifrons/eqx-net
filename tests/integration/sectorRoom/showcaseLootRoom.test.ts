/**
 * The "open a pod" showcase shot (`showcase/shots/loot.ts`) films a real kill
 * dropping a pod. The death coin flip is seeded by the drone id, so the room is
 * laid out around which drone's loot survives: this test fails if that ever
 * changes (a loot-table or flip change), before a film wastes a queue slot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_LOOT_OPTS } from '../../../src/server/rooms/showcaseRooms.js';

describe('showcase-loot room', () => {
  let h: SectorTestHarness;
  afterEach(async () => { if (h) await h.cleanup(); });

  it('killing the near heavy drops a pod', { timeout: 30_000 }, async () => {
    h = await bootSectorTestServer({ ...SHOWCASE_LOOT_OPTS, sectorKey: 'sol-prime' } as never);
    const cr = await h.connectActive(randomUUID(), { spawnX: 0, spawnY: -60 });
    const i = (matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom)._internals;
    const near = 'pose-drone-1';
    expect(i.swarmRegistry.get(near)?.shipKind).toBe('heavy');
    for (let k = 0; k < 10 && i.swarmRegistry.get(near); k++) i.applyDamage(near, 'someone', 99999);
    expect(i.swarmRegistry.get(near) ?? null).toBeNull();
    expect(i.loot.podCount(), 'the shot needs this kill to drop a pod').toBe(1);
  });
});
