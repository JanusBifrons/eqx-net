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
  /** The pilot's ship kind, when not a fighter (e.g. a capital so NPC main
   *  guns can lock it). */
  pilotKind?: string;
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
    // Showcase (local, unfiled): a small 3v3 fighter fight to film dogfighting.
    id: 'dogfight-3v3',
    title: 'Three drone fighters vs three robots (small dogfight)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'spawn', tag: 'blue', kind: 'fighter', count: 3, x: -750, y: 0, spread: 150 },
        { atMs: 0, action: 'spawn', tag: 'red', kind: 'robot-square', count: 3, x: 750, y: 0, spread: 150 },
        { atMs: 60_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -2200 },
    camera: { x: 0, y: 0, zoom: 0.6 },
    durationMs: 60_000,
    minSwarm: 0,
  },
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
  {
    // Wrap-up W2d (capitals P5 baseline): capital turret fire control, naval
    // shells and big hulls in a real fight. Capitals are drone-side; robots
    // are hostile to them on sight, so the two sides engage without orders.
    id: 'capital-fleet',
    title: 'A capital fleet (battleship, 2 destroyers, 6 gunships) against 30 robots, reinforced',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'spawn', tag: 'flagship', kind: 'battleship', count: 1, x: 0, y: 0, spread: 0 },
        { atMs: 0, action: 'spawn', tag: 'destroyers', kind: 'destroyer', count: 2, x: 0, y: 0, spread: 4000 },
        { atMs: 0, action: 'spawn', tag: 'gunships', kind: 'gunship', count: 6, x: 0, y: -3500, spread: 800 },
        ...[0, 10_000, 20_000].map((t, i) => fight(`robots${i}`, 'robot-square', 0, 9000, 10, t)),
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -9000 },
    camera: { x: 0, y: 2500, zoom: 0.15 },
    durationMs: 30_000,
    minSwarm: 5,
  },
  {
    // Wrap-up W2d: one battleship's main battery on the pilot (the duel shot
    // as a measurement): slow turrets, 16" shells, the lit hull up close.
    id: 'capital-duel',
    title: 'One battleship engages the pilot from 4 km',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'spawn', tag: 'battleship', kind: 'battleship', count: 1, x: 0, y: 0, spread: 0, hostile: true },
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 4000, y: 0 },
    camera: { x: 2000, y: 0, zoom: 0.2 },
    durationMs: 30_000,
    minSwarm: 1,
  },
  {
    // Shells as events, slice 3 (docs/architecture/shell-events.md): ten
    // battleships, hostile, open fire on a capital pilot 15 km off (NPC
    // capital turrets engage pilots and structures, never other NPCs, and a
    // main gun never locks a fighter, hence the battleship pilot). Locks are
    // capped at 2 s so the guns open inside the window. Run it with
    // EQX_NAVAL_RANGE=real (+ the client's navalRange=real). Slice 3 measured
    // events off vs on with it (rx 254 -> 67 KB/s); since slice 4 there is no
    // switch, so it now tracks the naval-shell wire cost base vs head.
    id: 'naval-broadside',
    title: 'Ten battleships fire on a capital pilot 15 km off',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      lockTimeCapS: 2,
      pilotCapitals: true,
      sceneScript: [
        { atMs: 0, action: 'spawn', tag: 'battleline', kind: 'battleship', count: 10, x: 0, y: 0, spread: 6000, hostile: true },
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: 15_000 },
    pilotKind: 'battleship',
    camera: { x: 0, y: 12_000, zoom: 0.05 },
    durationMs: 30_000,
    minSwarm: 10,
  },
];

export function perfSceneById(id: string): PerfScene | undefined {
  return PERF_SCENES.find((s) => s.id === id);
}
