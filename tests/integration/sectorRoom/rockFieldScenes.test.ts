/**
 * Macro-terrain Stage 0 (docs/architecture/macro-terrain.md): the terrain
 * stress scenes build what they say. A still rock field from the bulk seed
 * (`swarmRatio: 1`, `swarmAtRest`) holds exactly the requested rocks, no
 * drones, and the rocks settle into physics sleep: the measurements of the
 * asleep-vs-awake cost are only valid if they really sleep. Counts only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { perfSceneById, ROCK_FIELD_SMALL } from '../../../src/shared-types/perf/perfScenes.js';
import type { ScenePerfView } from '../../../src/server/rooms/scene/scenePerfRegistry.js';

interface Room {
  _internals: { swarmRegistry: { all(): Iterable<{ kind: number }> } };
  scenePerf(): ScenePerfView | null;
}

let harness: SectorTestHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('SectorRoom integration — terrain stress scenes', () => {
  it('rock-field-1k: exactly the requested rocks, no drones, and they fall asleep', { timeout: 60_000 }, async () => {
    const scene = perfSceneById('rock-field-1k')!;
    const r = scene.room;
    harness = await bootSectorTestServer({
      sectorKey: null,
      swarmCount: r['swarmCount'] as number,
      swarmRatio: r['swarmRatio'] as number,
      swarmRadius: r['swarmRadius'] as number,
      swarmAtRest: r['swarmAtRest'] as boolean,
      sceneScript: scene.room.sceneScript,
      defaultSpawnX: scene.spawn.x,
      defaultSpawnY: scene.spawn.y,
    });
    await harness.connectActive(randomUUID());
    const room = harness.getServerRoom() as unknown as Room;

    let rocks = 0, others = 0;
    for (const rec of room._internals.swarmRegistry.all()) {
      if (rec.kind === 0) rocks++; else others++;
    }
    expect(rocks).toBe(ROCK_FIELD_SMALL);
    expect(others).toBe(0);

    // Still rocks at the real asteroid mass go to sleep (Rapier + the
    // worker's 12-tick hysteresis). Wait on the count, with a deadline.
    const deadline = Date.now() + 30_000;
    let sleeping = 0;
    while (Date.now() < deadline) {
      await harness.advance(500);
      sleeping = room.scenePerf()?.bodies.sleeping ?? 0;
      if (sleeping >= ROCK_FIELD_SMALL) break;
    }
    expect(sleeping).toBe(ROCK_FIELD_SMALL);
  });
});
