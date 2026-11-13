/**
 * Diagnostic, OFF by default: the headless sub-cap debris soak (the
 * `fleet-fight-soak-lite` perf scene on a real server, no browser) with the
 * physics worker's wreck WAKE CENSUS on (`core/physics/wakeCensus.ts`).
 * Prints, every 15 s of scene time, how many wreck pieces are asleep (all,
 * and older than 20 s), what woke them and why the awake ones are awake.
 *
 *   EQX_WRECK_SOAK_S=210 pnpm vitest run --config vitest.integration.config.ts tests/integration/sectorRoom/wreckSleepSoak.test.ts
 *
 * The server-side sleep numbers don't need the client (the pilot is only a
 * body at the spawn); the wire/frame costs still need `pnpm perf:scenes`.
 * Results: docs/architecture/capital-destruction.md "Soak results".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { perfSceneById } from '../../../src/shared-types/perf/perfScenes.js';
import type { ScenePerfView } from '../../../src/server/rooms/scene/scenePerfRegistry.js';

const SOAK_S = Number(process.env['EQX_WRECK_SOAK_S'] ?? 0);
const SAMPLE_S = 15;

describe.runIf(SOAK_S > 0)('wreck sleep soak (diagnostic)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); harness = undefined; }, 15_000);

  it(`fleet-fight-soak-lite for ${SOAK_S} s: wreck pieces asleep over time`, { timeout: (SOAK_S + 60) * 1000 }, async () => {
    process.env['EQX_WAKE_CENSUS'] = '1';
    const scene = perfSceneById('fleet-fight-soak-lite')!;
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, asteroidConfig: [],
      subcapWrecks: true,
      sceneScript: scene.room.sceneScript,
      perfFixedLoad: true,
      defaultSpawnX: scene.spawn.x,
      defaultSpawnY: scene.spawn.y,
    });
    await harness.connectActive(randomUUID(), { initialHull: 1_000_000 });
    const room = harness.getServerRoom() as unknown as { scenePerf(): ScenePerfView | null };
    let next = SAMPLE_S;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const v = room.scenePerf();
      const t = (v?.scene.elapsedMs ?? 0) / 1000;
      if (t < next) continue;
      next += SAMPLE_S;
      const b = v!.bodies;
      const c = v!.wakeCensus as Record<string, unknown> | null;
      const oldPct = c && (c['oldPieces'] as number) > 0 ? Math.round((100 * (c['oldAsleep'] as number)) / (c['oldPieces'] as number)) : null;
      console.log(`[wreck-soak] t=${t.toFixed(0)}s pieces ${b.wreckPieces} asleep ${b.wreckPieces ? Math.round((100 * b.wreckSleeping) / b.wreckPieces) : 0}% old>20s asleep ${oldPct ?? '-'}% (${c?.['oldAsleep'] ?? '-'}/${c?.['oldPieces'] ?? '-'}) swarm ${b.swarm} worker p95 ${v!.workerTickRecent.p95.toFixed(2)} | ${JSON.stringify(c)}`);
      if (t >= SOAK_S) break;
    }
    expect(true).toBe(true);
  });
});
