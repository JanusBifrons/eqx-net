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
  /** Left out of a default `pnpm perf:scenes` run (name it with
   *  `--scenes`): the long soaks, and the terrain stress scenes, which only
   *  terrain PRs need. */
  soak?: boolean;
  /** A flying pilot: the client spawns facing `initialAngle` and the runner
   *  holds these keys for the whole window. The camera then follows the ship
   *  as in play (`camera` is not held). */
  pilotHold?: { keys: string[]; initialAngle: number };
  /** A moving director camera instead of the held `camera`: cinema holds,
   *  each eased in over `smoothMs` from its `atMs` (ms after the window
   *  starts). `scale` is the ABSOLUTE camera scale (screen px per world unit),
   *  not width-normalised like `camera.zoom`, so a zoom threshold is hit on
   *  every viewport. */
  cameraPath?: { atMs: number; smoothMs: number; x: number; y: number; scale: number }[];
}

const fight = (tag: string, kind: string, x: number, y: number, count: number, atMs = 0): Extract<SceneStep, { action: 'spawn' }> =>
  ({ atMs, action: 'spawn', tag, kind, count, x, y, spread: 260 });

/** Both sides, reinforced every 10 s: a 30-ship clash is over in ~10 s, so
 *  without reinforcements most of the window would measure the aftermath. */
const sustainedFight = (n: number, x: number, y: number, gap: number): SceneStep[] =>
  [0, 10_000, 20_000].flatMap((t, i) => [
    fight(`blue${i}`, 'fighter', x - gap, y, n, t),
    fight(`red${i}`, 'robot-square', x + gap, y, n, t),
  ]);

/** Macro-terrain Stage 0 (docs/architecture/macro-terrain.md): a still rock
 *  field from the bulk seed (`swarmRatio: 1` = rocks only, `swarmAtRest` =
 *  real asteroid mass, no drift, so the rocks settle and sleep). Counts stay
 *  under the 5,120-slot cap with room for the ships and scrap of a fight. */
const rockField = (count: number, radius: number): Record<string, unknown> =>
  ({ droneCount: 0, swarmCount: count, swarmRatio: 1, swarmRadius: radius, swarmAtRest: true });

/** Rock counts of the terrain scenes (the integration census reads these). */
export const ROCK_FIELD_SMALL = 1000;
export const ROCK_FIELD_LARGE = 4500;
export const ROCK_FIELD_FIGHT = 4000;

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
    // Sub-capital break-up slice 5 (plan subcapital-breakup.md): the
    // fleet-fight setup played for ten minutes with `subcapWrecks` on, so
    // every kill leaves permanent pieces that drift to a stop and sleep. Run
    // with `--sample-ms 30000` for the over-time curve (pieces alive, sleeping
    // share, tick cost, wire, frame time); `--base-env EQX_SUBCAP_WRECKS=0`
    // is the same scene with the flag forced off. Results:
    // docs/architecture/capital-destruction.md "Soak results".
    id: 'fleet-fight-soak',
    title: 'The fleet fight for 10 minutes with sub-cap wrecks on (debris soak)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      subcapWrecks: true,
      sceneScript: [
        { ...fight('blue', 'fighter', -300, 1200, 30), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { ...fight('red', 'robot-square', 300, 1200, 30), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { atMs: 600_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 600_000,
    minSwarm: 30,
    soak: true,
  },
  {
    // The same soak at 10 ships a side a wave. The full soak's 30-a-side
    // waves outrun the killing (~250 more ships alive a minute), so its client
    // falls over within ~2.5 min whatever the debris does; at 10 a side the
    // fight stays bounded and the debris is what grows (slice 5 soak results).
    id: 'fleet-fight-soak-lite',
    title: 'A bounded 10-a-side fleet fight for 10 minutes with sub-cap wrecks on (debris soak)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      subcapWrecks: true,
      sceneScript: [
        { ...fight('blue', 'fighter', -300, 1200, 10), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { ...fight('red', 'robot-square', 300, 1200, 10), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { atMs: 600_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 600_000,
    minSwarm: 10,
    soak: true,
  },
  {
    // The lite soak with the sector's automatic slowdown ON (time scale
    // Phase 5, `LoadSpeedController`, 0.7 floor), as in a real sector: test
    // rooms have it off unless they opt in. Asks whether the game's own time
    // dilation keeps the client smooth as the debris grows. The scene clock
    // is game time, so a slowed take runs up to 1/0.7 × longer in wall time.
    // `perfFixedLoad: false` is load-bearing: perf rooms default to fixed
    // load, which skips the slowdown controller (and the cost clock and load
    // shedder) even with `autoTimeScale` on. Here the room protects itself
    // exactly as a real sector does.
    id: 'fleet-fight-soak-lite-dilated',
    title: 'The lite debris soak with the automatic slowdown on (time dilation)',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      subcapWrecks: true,
      autoTimeScale: true,
      perfFixedLoad: false,
      sceneScript: [
        { ...fight('blue', 'fighter', -300, 1200, 10), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { ...fight('red', 'robot-square', 300, 1200, 10), repeatEveryMs: 10_000, repeatUntilMs: 600_000 },
        { atMs: 600_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 600_000,
    minSwarm: 10,
    soak: true,
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
    // RTS command layer: the cost of a big AI-flown fleet. 40 parked fighters
    // owned by the pilot, each flown by its wingman brain (hunt, aggressive:
    // re-plan, owner-hostile scan, own locks, player fire pipeline), against
    // 20 hostile drones reinforced every 8 s. The hulls' hit points are huge
    // so the fleet stays 40 strong for the whole window. A/B it against the
    // same build with EQX_DISABLE_WINGMEN=1 (--base-env): the hulls then sit
    // parked, as they do on main before the RTS layer.
    id: 'rts-fleet',
    title: '40 AI-flown parked hulls hunt 20 hostile drones, reinforced every 8 s',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'fleet', tag: 'wing', kind: 'fighter', count: 40, x: 0, y: 0, spread: 500, mode: 'hunt', stance: 'aggressive', health: 1_000_000 },
        ...[0, 8_000, 16_000, 24_000].map((t, i): SceneStep =>
          ({ atMs: t, action: 'spawn', tag: `foe${i}`, kind: 'fighter', count: 20, x: 0, y: 900, spread: 260, hostile: true })),
        { atMs: 30_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -900 },
    camera: { x: 0, y: 300, zoom: 0.45 },
    durationMs: 30_000,
    minSwarm: 1,
  },
  {
    // Shells as events, slice 3 (docs/architecture/shell-events.md): ten
    // battleships, hostile, open fire on a capital pilot 15 km off (NPC
    // capital turrets engage pilots and structures, never other NPCs, and a
    // main gun never locks a fighter, hence the battleship pilot). Locks are
    // capped at 2 s so the guns open inside the window. Runs at real naval
    // ranges (the default since 2026-11-14). Slice 3 measured
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
  {
    // Rock cut (salvage stream, docs/features/mining-and-salvage.md): eight
    // rocks mined to a break at t = 2 s, their wreck pieces on screen at the
    // normal zoom, where each piece draws its stretch of the rock's art as one
    // batched mesh. The intact arm: `--base HEAD --base-env EQX_SCENE_ROCK_CUT=0`
    // (the same rocks left whole).
    id: 'rock-cut',
    title: 'Eight rocks mined into wreck pieces, seen at the normal zoom',
    room: {
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'rocks', tag: 'rock', count: 8, x: 0, y: 0, spread: 700, radius: 90 },
        { atMs: 2000, action: 'rockCut', tag: 'rock', count: 8 },
        { atMs: 20_000, action: 'end' },
      ],
    },
    spawn: { x: 0, y: -1100 },
    camera: { x: 0, y: 0, zoom: 0.6 },
    durationMs: 20_000,
    minSwarm: 8,
  },
  {
    // Macro-terrain Stage 0: what a still field costs at a modest count.
    id: 'rock-field-1k',
    title: '1,000 still rocks in a 9 km disc, pilot idle in the middle',
    room: { ...rockField(ROCK_FIELD_SMALL, 9000), sceneScript: [{ atMs: 20_000, action: 'end' }] },
    spawn: { x: 0, y: 0 },
    camera: { x: 0, y: 0, zoom: 0.45 },
    durationMs: 20_000,
    minSwarm: ROCK_FIELD_SMALL,
    soak: true,
  },
  {
    // Macro-terrain Stage 0: the same field density over a wider disc, near
    // the slot cap. Expected walls: the 1 Hz full snapshot resends every rock
    // to every client, and the client keeps one display object per rock.
    id: 'rock-field-4500',
    title: '4,500 still rocks in a 19 km disc, pilot idle in the middle',
    room: { ...rockField(ROCK_FIELD_LARGE, 19_000), sceneScript: [{ atMs: 20_000, action: 'end' }] },
    spawn: { x: 0, y: 0 },
    camera: { x: 0, y: 0, zoom: 0.45 },
    durationMs: 20_000,
    minSwarm: ROCK_FIELD_LARGE,
    soak: true,
  },
  {
    // Macro-terrain Stage 0: a fight inside a field, so shots, rams and
    // explosions wake rocks (churn between awake and asleep).
    id: 'rock-field-fight',
    title: 'A 10-a-side fight, reinforced, inside 4,000 still rocks',
    room: {
      ...rockField(ROCK_FIELD_FIGHT, 18_000),
      sceneScript: [...sustainedFight(10, 0, 1200, 300), { atMs: 30_000, action: 'end' }],
    },
    spawn: { x: 0, y: -400 },
    camera: { x: 0, y: 1200, zoom: 0.45 },
    durationMs: 30_000,
    minSwarm: ROCK_FIELD_FIGHT,
    soak: true,
  },
  {
    // Macro terrain v2 slice 4: the cut field (seed `look`, the showcase
    // room's field), pilot idle beside lane 1's wall, camera pulled out so
    // the client draws every chunk it has cut (7×7). Only rocks near ships
    // exist on the server (chunks stream in as fixed bodies), so `minSwarm`
    // just proves the field loaded.
    id: 'cut-field',
    title: 'The cut field: pilot idle beside a lane wall, camera pulled out',
    room: { droneCount: 0, asteroidConfig: [], cutField: { seed: 'look' }, sceneScript: [{ atMs: 20_000, action: 'end' }] },
    spawn: { x: -30_002, y: 27_191 },
    camera: { x: -30_002, y: 27_191, zoom: 0.08 },
    durationMs: 20_000,
    minSwarm: 1,
    soak: true,
  },
  {
    // The cut field while flying: a fighter holds thrust + boost straight
    // down lane 1's centre line (4.6 km to each wall), so chunks stream in
    // on both sides for the whole window: the cut, body and draw cost of
    // moving through the field.
    id: 'cut-field-run',
    title: 'The cut field: a fighter flying flat out down a lane',
    room: { droneCount: 0, asteroidConfig: [], cutField: { seed: 'look' }, sceneScript: [{ atMs: 30_000, action: 'end' }] },
    spawn: { x: -11_147, y: 20_249 },
    pilotHold: { keys: ['w', 'Shift'], initialAngle: 1.028 },
    camera: { x: -11_147, y: 20_249, zoom: 0.45 },
    durationMs: 30_000,
    minSwarm: 1,
    soak: true,
  },
  {
    // Macro terrain B4: the cut field from far out, where the coarse far-zoom
    // tiles draw. A battleship pilot (whose own zoom floor is ~0.0048) sits
    // idle; the director camera holds at that floor for the first half and
    // just past the far switch (`FAR_FIELD_SWITCH_SCALE` ≈ 0.0215, rock-size
    // cut fully on) for the second, panning slowly so tiles enter and leave
    // the view. Scales are absolute (`cameraPath`), so every viewport sees
    // the same zooms. Runs on a build without the far view too (fair A/B).
    id: 'cut-field-far',
    title: 'The cut field from far out: battleship floor zoom, then just past the far switch, panning',
    room: { droneCount: 0, asteroidConfig: [], cutField: { seed: 'look' }, pilotCapitals: true, sceneScript: [{ atMs: 30_000, action: 'end' }] },
    spawn: { x: -11_147, y: 20_249 },
    pilotKind: 'battleship',
    camera: { x: -11_147, y: 20_249, zoom: 0.02 },
    cameraPath: [
      { atMs: 0, smoothMs: 0, x: -30_000, y: 10_000, scale: 0.00484 },
      { atMs: 500, smoothMs: 13_000, x: 10_000, y: 35_000, scale: 0.00484 },
      { atMs: 14_000, smoothMs: 1500, x: 0, y: 30_000, scale: 0.0215 },
      { atMs: 16_000, smoothMs: 13_000, x: -25_000, y: 20_000, scale: 0.0215 },
    ],
    durationMs: 30_000,
    minSwarm: 1,
    soak: true,
  },
];

export function perfSceneById(id: string): PerfScene | undefined {
  return PERF_SCENES.find((s) => s.id === id);
}
