/**
 * Rooms playing a perf scene, for `GET /dev/perf` (plan prancy-squishing-donut
 * P2). Test rooms only: a room joins when created with a `sceneScript` and
 * leaves on dispose.
 */
import type { FrameTimeSummary } from '../../../core/perf/FrameTimeRing.js';
import type { SceneStatus } from './SceneScriptRunner.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
