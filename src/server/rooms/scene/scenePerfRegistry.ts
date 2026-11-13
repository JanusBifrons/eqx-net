/**
 * Rooms playing a perf scene, for `GET /dev/perf` (plan prancy-squishing-donut
 * P2). Test rooms only: a room joins when created with a `sceneScript` and
 * leaves on dispose.
 */
import type { FrameTimeSummary } from '../../../core/perf/FrameTimeRing.js';
import type { SceneStatus } from './SceneScriptRunner.js';
import type { SceneWorkView } from './SceneWorkCounters.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ScenePerfView {
  roomId: string;
  scene: SceneStatus;
  /** Server `update()` time per tick while the scene runs (start → end). */
  tick: FrameTimeSummary;
  /** Physics-worker step time per tick while the scene runs. */
  workerTick: FrameTimeSummary;
  /** The same over the last `SCENE_RECENT_TICKS` ticks only: a soak's
   *  over-time curve (`perf:scenes --sample-ms`). */
  tickRecent: FrameTimeSummary;
  workerTickRecent: FrameTimeSummary;
  /** Census at read time: swarm bodies, how many the worker flags SLEEPING,
   *  live wreck pieces (and asleep), the sub-cap FIFO and live wreck
   *  descriptors (sub-cap break-up slice 5). */
  bodies: { swarm: number; sleeping: number; wreckPieces: number; wreckSleeping: number; wreckSubcapLive: number; wreckDescriptors: number };
  swarm: number;
  players: number;
  structures: number;
  /** Work counters per tick (WS3; gated by perfSceneCounts.test.ts) plus
   *  print-only CPU time. */
  work: SceneWorkView;
  /** Game time against wall time while the scene runs (game time scale,
   *  Phase 1, print-only): 60 Hz ticks real time allowed, ticks the worker
   *  ran, the difference, and how many the worker's catch-up cap dropped. */
  simTime: { wallTicks: number; simTicks: number; latenessTicks: number; droppedTicks: number };
}

export interface ScenePerfSource { scenePerf(): ScenePerfView | null }

/** `tickRecent` window: the last 30 s of 60 Hz ticks. */
export const SCENE_RECENT_TICKS = 1800;

const rooms = new Set<ScenePerfSource>();

export function registerScenePerfRoom(r: ScenePerfSource): void { rooms.add(r); }
export function unregisterScenePerfRoom(r: ScenePerfSource): void { rooms.delete(r); }
export function scenePerfViews(): ScenePerfView[] {
  const out: ScenePerfView[] = [];
  for (const r of rooms) { const v = r.scenePerf(); if (v) out.push(v); }
  return out;
}

/** Client readings posted by the perf lab (`POST /dev/perf/client`). Kept in
 *  memory (last 50) and, when `EQX_PERF_LEDGER_DIR` is set, written to disk
 *  so Claude reads them; the user never pastes numbers. */
const clientReadings: unknown[] = [];

export function recordClientReading(r: unknown): string | null {
  clientReadings.push(r);
  if (clientReadings.length > 50) clientReadings.shift();
  const dir = process.env['EQX_PERF_LEDGER_DIR'];
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(r, null, 2));
  return file;
}

export function clientPerfReadings(): readonly unknown[] { return clientReadings; }

/** Game time vs wall time between two marks (worker tick, dropped ticks,
 *  wall ms). Pure, for `ScenePerfView.simTime`. */
export function sceneSimTime(
  start: { ms: number; tick: number; dropped: number },
  end: { ms: number; tick: number; dropped: number },
  /** The sector's game speed: real time allows 60 × this ticks per second. */
  timeScale = 1,
): ScenePerfView['simTime'] {
  const wallTicks = Math.max(0, Math.round(((end.ms - start.ms) * 60 * timeScale) / 1000));
  const simTicks = (end.tick - start.tick) >>> 0;
  return {
    wallTicks,
    simTicks,
    latenessTicks: wallTicks - simTicks,
    droppedTicks: (end.dropped - start.dropped) >>> 0,
  };
}
