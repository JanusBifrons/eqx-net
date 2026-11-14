/**
 * RTS fleet perf scene (`rts-fleet`): the scene's `fleet` step gives the first
 * pilot 40 parked hulls, each flown by its wingman brain (hunt, aggressive),
 * and they fight the hostile drone pack. Locks that the scene measures what it
 * says (every hull attached, one owner-hostile scan per tick, wingmen firing),
 * and prints the per-tick work counters the perf runner records.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { perfSceneById } from '../../../src/shared-types/perf/perfScenes.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SceneStatus } from '../../../src/server/rooms/scene/SceneScriptRunner.js';
import type { ScenePerfView } from '../../../src/server/rooms/scene/scenePerfRegistry.js';

type SceneRoom = { sceneStatus(): SceneStatus | null; scenePerf(): ScenePerfView | null; _internals: SectorRoom['_internals'] };

describe('perf scene rts-fleet — an AI-flown fleet of parked hulls', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it('gives the pilot 40 wingmen that hunt and fire, one hostile scan per owner per tick', { timeout: 60_000 }, async () => {
    const scene = perfSceneById('rts-fleet')!;
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, asteroidConfig: [],
      sceneScript: scene.room.sceneScript, perfFixedLoad: true,
      defaultSpawnX: scene.spawn.x, defaultSpawnY: scene.spawn.y,
    });
    const pid = randomUUID();
    await harness.connectActive(pid, { initialHull: 1_000_000 });
    const room = harness.getServerRoom() as unknown as SceneRoom;
    const deadline = Date.now() + 30_000;
    while ((room.scenePerf()?.work.ticks ?? 0) < 360) {
      if (Date.now() > deadline) throw new Error(`scene reached only ${room.scenePerf()?.work.ticks} ticks`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = room.sceneStatus()!;
    const work = room.scenePerf()!.work;
    console.log(`[rts-fleet] status ${JSON.stringify(status)} work ${JSON.stringify(work)}`);
    expect(status.refused, 'no hull or drone refused').toBe(0);
    expect(status.spawned).toBe(60);
    expect(room._internals.fleet.size, 'every hull has a brain').toBe(40);
    // The counted window opens at `start` (the pilot's ready), a few dozen
    // ticks before the arrival tick plays the fleet step.
    expect(work.wingmenPerTick).toBeGreaterThan(34);
    expect(work.wingmenPerTick).toBeLessThanOrEqual(40);
    // ~10 Hz re-plan, staggered: 40 / 6 per tick.
    expect(work.wingmanReplansPerTick).toBeGreaterThan(5 * 0.85);
    expect(work.wingmanReplansPerTick).toBeLessThan(8);
    // One owner ⇒ at most one swarm scan per tick, however many wingmen ask.
    expect(work.wingmanHostileScansPerTick).toBeLessThanOrEqual(1);
    expect(work.wingmanHostileQueriesPerTick).toBeGreaterThan(work.wingmanHostileScansPerTick);
    // The AI target view of the parked hulls allocates nothing per tick: a
    // second build hands back the same 40 view objects, with fresh values.
    const visit = (room as unknown as { _visitLingeringTargets(out: unknown[]): void })._visitLingeringTargets;
    const a: Array<{ id: string; x: number }> = [], b: Array<{ id: string; x: number }> = [];
    visit(a); visit(b);
    expect(a).toHaveLength(40);
    for (let i = 0; i < a.length; i++) expect(b[i], `view ${i} is reused`).toBe(a[i]);
    expect(new Set(b.map((v) => v.id)).size, 'one view per hull').toBe(40);
    // The wingmen fight: drones of the first wave have died.
    let firstWaveAlive = 0;
    for (let i = 0; i < 20; i++) if (room._internals.swarmHealth.has(`scene-foe0-${i}`)) firstWaveAlive++;
    expect(firstWaveAlive, 'the wingmen killed some of the first wave').toBeLessThan(20);
  });
});
