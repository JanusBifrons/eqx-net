/**
 * Perf counts gate (plan prancy-squishing-donut P3.5): what a pilot RECEIVES
 * in a perf scene stays under budget, on every PR.
 *
 * Timings need the same machine and a same-session base (`pnpm perf:scenes`).
 * Counts don't: snapshots go out at a fixed 20 Hz, so bytes per second and
 * live entities barely depend on how fast the CI runner is. This plays the
 * real scene (same catalogue entry as the perf room) with a connected pilot
 * and counts the bytes its socket receives over a fixed window.
 *
 * Budgets live in `src/shared-types/perf/perfBudgets.ts`, each with the
 * measurement that set it. Raise one only with a new measurement and a reason.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { perfSceneById } from '../../../src/shared-types/perf/perfScenes.js';
import { COUNT_BUDGETS, WORK_WINDOW_TICKS, type WorkBudget } from '../../../src/shared-types/perf/perfBudgets.js';
import type { SceneStatus } from '../../../src/server/rooms/scene/SceneScriptRunner.js';
import type { ScenePerfView } from '../../../src/server/rooms/scene/scenePerfRegistry.js';

type SceneRoom = { sceneStatus(): SceneStatus | null; swarmRegistry: { size(): number }; scenePerf(): ScenePerfView | null };
const WINDOW_MS = 10_000;

describe('perf scenes — counts stay under budget', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  for (const id of Object.keys(COUNT_BUDGETS)) {
    it(`${id}: bytes a pilot receives per second, server work per tick`, { timeout: 90_000 }, async () => {
      const scene = perfSceneById(id)!;
      const budget = COUNT_BUDGETS[id]!;
      const r = scene.room as Record<string, unknown>;
      harness = await bootSectorTestServer({
        sectorKey: null,
        droneCount: (r['droneCount'] as number | undefined) ?? 0,
        ...(r['asteroidConfig'] ? { asteroidConfig: r['asteroidConfig'] as [] } : {}),
        ...(r['sectorFeatures'] ? { sectorFeatures: r['sectorFeatures'] as [] } : {}),
        ...(r['npcBases'] ? { npcBases: r['npcBases'] as never } : {}),
        sceneScript: scene.room.sceneScript,
        perfFixedLoad: true,
        defaultSpawnX: scene.spawn.x,
        defaultSpawnY: scene.spawn.y,
      });
      const cr = await harness.connectActive(randomUUID(), { initialHull: 1_000_000 });
      const ws = (cr as unknown as { connection: { transport: { ws: { addEventListener(t: string, f: (e: { data: ArrayBuffer | string }) => void): void } } } }).connection.transport.ws;
      let bytes = 0;
      ws.addEventListener('message', (e) => { bytes += typeof e.data === 'string' ? e.data.length : e.data.byteLength; });
      const room = harness.getServerRoom() as unknown as SceneRoom;
      // Let the scene's first spawns land, then count over a fixed window.
      await new Promise((res) => setTimeout(res, 2000));
      bytes = 0;
      const t0 = Date.now();
      await new Promise((res) => setTimeout(res, WINDOW_MS));
      const kbps = bytes / 1024 / ((Date.now() - t0) / 1000);
      const status = room.sceneStatus()!;
      const swarm = room.swarmRegistry.size();
      console.log(`[perf-counts] ${id}: ${kbps.toFixed(1)} KB/s, swarm ${swarm}, spawned ${status.spawned}`);
      expect(status.refused, 'a scene spawn was refused: the run is invalid').toBe(0);
      expect(swarm, 'the scene must actually be busy').toBeGreaterThanOrEqual(budget.minSwarm);
      // Soft: one run reports EVERY budget it broke, not just the first.
      expect.soft(kbps, `${id}: ${kbps.toFixed(1)} KB/s over the ${budget.rxKBps} KB/s budget (${budget.measured})`).toBeLessThanOrEqual(budget.rxKBps);

      // Server work per tick, over a fixed number of SCENE ticks (the script
      // is tick-driven, so a slow runner covers the same part of the scene;
      // only the wall-clock wait gets longer).
      const deadline = Date.now() + 60_000;
      while ((room.scenePerf()?.work.ticks ?? 0) < WORK_WINDOW_TICKS) {
        if (Date.now() > deadline) throw new Error(`${id}: scene reached only ${room.scenePerf()?.work.ticks} of ${WORK_WINDOW_TICKS} ticks`);
        await new Promise((res) => setTimeout(res, 20));
      }
      const work = room.scenePerf()!.work;
      console.log(`[perf-counts] ${id} work: ${JSON.stringify(work)}`);
      if (!budget.work) return;
      for (const k of Object.keys(budget.work) as Array<keyof WorkBudget>) {
        expect.soft(work[k], `${id}: ${k} ${work[k]} over the ${budget.work[k]} budget (${budget.measured})`).toBeLessThanOrEqual(budget.work[k]);
      }
    });
  }
});
