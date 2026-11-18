/**
 * Perf scenes (plan prancy-squishing-donut P1): one test room per catalogue
 * entry, `perf-<id>`, played by `pnpm perf:scenes`. Moved out of `index.ts`
 * (god-file cap).
 */
import type { Server } from 'colyseus';
import { PERF_SCENES, type PerfScene } from '../../shared-types/perf/perfScenes.js';
import { resolveSectorConfig } from '../galaxy/GalaxyRegistry.js';

/** The room options for one perf scene. */
export function perfRoomOptions(scene: PerfScene, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const o: Record<string, unknown> = {
    testMode: true,
    defaultSpawnX: scene.spawn.x,
    defaultSpawnY: scene.spawn.y,
    maxClients: 4,
    // Fault injection for the runner's self-test: burn N ms of every tick.
    tickBurnMs: Number(env['EQX_PERF_BURN_MS'] ?? 0),
    // Fixed work: no TiDi, no load shedding (they hide an overload).
    perfFixedLoad: true,
    ...scene.room,
    // A real galaxy sector's field (F4); `EQX_SCENE_GALAXY_FIELD=0` is the
    // A/B's no-field arm.
    ...(scene.galaxyField !== undefined && env['EQX_SCENE_GALAXY_FIELD'] !== '0'
      ? { cutField: resolveSectorConfig(scene.galaxyField).cutField }
      : {}),
  };
  // A wreck field scene's no-field arm: `EQX_SCENE_WRECK_FIELD=0`.
  if (scene.wreckFieldSwitch === true && env['EQX_SCENE_WRECK_FIELD'] === '0') delete o['wreckField'];
  return o;
}

/** Registers every scene's room. The room class is passed in (`SectorRoom`)
 *  so this module, and its unit test, never load the schema decorators. */
export function definePerfRooms(gameServer: Server, room: Parameters<Server["define"]>[1]): void {
  for (const scene of PERF_SCENES) {
    gameServer.define(`perf-${scene.id}`, room, perfRoomOptions(scene)).filterBy(['testId']);
  }
}
