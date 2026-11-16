/**
 * The `rock-cut` perf scene really breaks its rocks (salvage stream, rock
 * cut): its eight rocks are mined to a break through the real wear path at
 * t = 2 s, each leaving a rock wreck and >= 2 pieces, so the perf A/B
 * measures pieces on screen, not whole rocks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { perfSceneById } from '../../../src/shared-types/perf/perfScenes.js';

const WRECK_KIND = 4;

let harness: SectorTestHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('SectorRoom integration: the rock-cut perf scene', () => {
  it('breaks all eight rocks into wreck pieces', { timeout: 60_000 }, async () => {
    const scene = perfSceneById('rock-cut')!;
    harness = await bootSectorTestServer({ ...scene.room, sectorKey: null, testMode: true } as never);
    await harness.connectActive(randomUUID(), { spawnX: scene.spawn.x, spawnY: scene.spawn.y });
    const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    await harness.advance(1000);
    const rockIds = [...int.swarmRegistry.all()].filter((r) => r.kind === 0).map((r) => r.id);
    expect(rockIds).toHaveLength(8);
    await harness.advance(2500);
    for (const id of rockIds) expect(int.swarmRegistry.get(id), `${id} broke`).toBeNull();
    const descs = int.wreckDescriptors().filter((d) => d.rock !== undefined);
    expect(descs).toHaveLength(8);
    const pieces = [...int.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND);
    expect(pieces.length).toBeGreaterThanOrEqual(16);
    console.log(`[rock-cut scene] ${pieces.length} pieces from 8 rocks`);
  });
});
