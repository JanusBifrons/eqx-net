/**
 * The perf-scene catalogue (plan prancy-squishing-donut P1). Each scene is a
 * test room (`perf-<id>`) plus what the runner does in it: the camera, how
 * long to measure, and the counts a valid run must reach.
 *
 * Plain data, imported by `src/server/index.ts` (room definitions) and by the
 * runner `perf/run-perf.ts` (camera + window), so both arms of an A/B read
 * the same definition. Adding a scene = one entry here.
 */
import type { SceneStep } from './SceneScriptRunner.js';

export interface PerfScene {
  id: string;
  /** What the scene stands for, in one line. */
  title: string;
  /** Room options (testMode is added by the definition). */
  room: Record<string, unknown> & { sceneScript: SceneStep[] };
  /** Pilot spawn. The pilot is a near-invulnerable, idle fighter. */
  spawn: { x: number; y: number };
  /** Camera for the whole window (game space, Y up). */
  camera: { x: number; y: number; zoom: number };
  /** Measurement window = scene start → its `end` step (ms). */
  durationMs: number;
  /** A run is valid only if at least this many swarm entities are live at the end. */
  minSwarm: number;
}

const fight = (tag: string, kind: string, x: number, y: number, count: number, atMs = 0): SceneStep =>
  ({ atMs, action: 'spawn', tag, kind, count, x, y, spread: 260 });

export const PERF_SCENES: readonly PerfScene[] = [
  {
    id: 'idle',
    title: 'Empty sector, pilot idle: the harness floor',
    room: { droneCount: 0, asteroidConfig: [], sceneScript: [{ atMs: 20_000, action: 'end' }] },
    spawn: { x: 0, y: 0 },
    camera: { x: 0, y: 0, zoom: 0.6 },
    durationMs: 20_000,
    minSwarm: 0,
  },
  {
    id: 'fleet-fight',
    title: 'Two 30-ship fleets fight (drones vs robots)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        fight('blue', 'fighter', -300, 1200, 30),
        fight('red', 'robot-square', 300, 1200, 30),
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 30_000,
    minSwarm: 1,
  },
  {
    id: 'teleport-raid',
    title: '40 ships warp in beside an NPC citadel at t = 5 s',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sectorFeatures: [],
      npcBases: [{ baseId: 'citadel', role: 'assembly', tier: 'citadel', seed: 15, x: 0, y: 0, features: [] }],
      sceneScript: [
        { atMs: 5_000, action: 'spawn', tag: 'raid', kind: 'fighter', count: 40, x: 0, y: -2600, spread: 400, warpIn: true },
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -4800 },
    camera: { x: 0, y: -2000, zoom: 0.25 },
    durationMs: 30_000,
    minSwarm: 1,
  },
  {
    id: 'wide-view',
    title: 'Fleet fight seen from the zoom-out floor',
    room: {
      droneCount: 0,
      sceneScript: [
        fight('blue', 'fighter', -600, 1500, 40),
        fight('red', 'robot-square', 600, 1500, 40),
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: 0 },
    camera: { x: 0, y: 800, zoom: 0.15 },
    durationMs: 30_000,
    minSwarm: 1,
  },
];

export function perfSceneById(id: string): PerfScene | undefined {
  return PERF_SCENES.find((s) => s.id === id);
}
