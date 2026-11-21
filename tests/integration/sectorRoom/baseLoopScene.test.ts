/**
 * The `base-loop` perf scene (plan step 4I) stages what it claims: the
 * joining pilot adopts the base, the Shipyard is BUILDING (running, not
 * starved or unpowered), the shield wall between the pylons is up and blocks
 * a shot, and the pilot's Mining Skiff and two Interceptors are parked
 * beside it. A silent miss here would time a quieter base than the loop's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { perfSceneById } from '../../../src/shared-types/perf/perfScenes.js';
import { perfRoomOptions } from '../../../src/server/rooms/perfRooms.js';
import { BASE_LOOP_AT } from '../../../src/server/rooms/scenarioLayouts.js';
import { PROD_STATE } from '../../../src/shared-types/production.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('SectorRoom integration: the base-loop perf scene', () => {
  it('builds in the Shipyard, holds the wall up and parks the pilot\'s ships', { timeout: 60_000 }, async () => {
    const scene = perfSceneById('base-loop')!;
    harness = await bootSectorTestServer({ ...perfRoomOptions(scene, {}), sectorKey: null } as never);
    const pilot = randomUUID();
    await harness.connectActive(pilot, { spawnX: scene.spawn.x, spawnY: scene.spawn.y });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    await harness.advance(3000);
    const structures = [...int.structureRegistry.all()];
    expect(structures).toHaveLength(14);
    expect(structures.every((r) => r.owner === pilot)).toBe(true);
    const yard = structures.find((r) => r.kind === 'shipyard')!;
    expect(yard.prodState).toBe(PROD_STATE.running);
    // A shot down across the wall line (pylons at y -1450, x ±350) is blocked.
    const blocked = int.blockShotAtWall(BASE_LOOP_AT.x, BASE_LOOP_AT.y - 1300, 0, -1, 400, 1);
    expect(blocked).not.toBeNull();
    expect(int.lingeringSlots.size).toBe(3);
  });
});
