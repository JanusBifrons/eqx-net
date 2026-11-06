/**
 * The perf-scene catalogue (plan prancy-squishing-donut P1). Each scene is a
 * test room (`perf-<id>`) plus what the runner does in it: the camera, how
 * long to measure, and the counts a valid run must reach.
 *
 * Plain data, read by `src/server/index.ts` (room definitions), the runner
 * `perf/run-perf.ts` and the phone perf lab (camera + window), so every
 * consumer reads the same definition. Adding a scene = one entry here.
 */
import type { SceneStep } from './sceneScript.js';

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

/** Both sides, reinforced every 10 s: a 30-ship clash is over in ~10 s, so
 *  without reinforcements most of the window would measure the aftermath. */
const sustainedFight = (n: number, x: number, y: number, gap: number): SceneStep[] =>
  [0, 10_000, 20_000].flatMap((t, i) => [
    fight(`blue${i}`, 'fighter', x - gap, y, n, t),
    fight(`red${i}`, 'robot-square', x + gap, y, n, t),
  ]);

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
    title: 'Two 30-ship fleets fight, reinforced every 10 s (drones vs robots)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [...sustainedFight(30, 0, 1200, 300), { atMs: 30_000, action: 'end' }],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 30_000,
    minSwarm: 30,
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
      sceneScript: [...sustainedFight(40, 0, 1500, 600), { atMs: 30_000, action: 'end' }],
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
