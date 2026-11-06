/**
 * Rooms playing a perf scene, for `GET /dev/perf` (plan prancy-squishing-donut
 * P2). Test rooms only: a room joins when created with a `sceneScript` and
 * leaves on dispose.
 */
import type { FrameTimeSummary } from '../../../core/perf/FrameTimeRing.js';
import type { SceneStatus } from './SceneScriptRunner.js';

export interface ScenePerfView {
  roomId: string;
  scene: SceneStatus;
  /** Server `update()` time per tick while the scene runs (start → end). */
  tick: FrameTimeSummary;
  /** Physics-worker step time per tick while the scene runs. */
  workerTick: FrameTimeSummary;
  swarm: number;
  players: number;
  structures: number;
}

export interface ScenePerfSource { scenePerf(): ScenePerfView | null }

const rooms = new Set<ScenePerfSource>();

export function registerScenePerfRoom(r: ScenePerfSource): void { rooms.add(r); }
export function unregisterScenePerfRoom(r: ScenePerfSource): void { rooms.delete(r); }
export function scenePerfViews(): ScenePerfView[] {
  const out: ScenePerfView[] = [];
  for (const r of rooms) { const v = r.scenePerf(); if (v) out.push(v); }
  return out;
}
