/**
 * The options `SectorRoom.onCreate` reads: `gameServer.define()`'s 3rd arg
 * (or a client's room-create options) flows into `onCreate(options)`, which
 * casts it to this shape. Type only, zero runtime. New room options go here,
 * not inline in SectorRoom (docs/architecture/god-file-extension-points.md).
 * Seed arrays are bounded at runtime by `assertRoomSeedBounds` (S5).
 */
import type { AsteroidSpec } from '../spawn/SwarmSpawner.js';
import type { AsteroidFieldFeature } from '../../shared-types/asteroidResources.js';
import type { FieldClearing } from '../../core/terrain/fieldLayout.js';
import type { WreckFieldRoomOpts } from './WreckFieldSource.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { GateAccess } from '../../shared-types/gateAccess.js';
import type { NpcBaseSpec } from '../bases/NpcBaseSubsystem.js';
import type { GoodId } from '../../shared-types/goods.js';

export interface SectorRoomOptions {
  testMode?: boolean;
  asteroidConfig?: ReadonlyArray<AsteroidSpec>;
  /** P2c (testMode) — sector features for a non-galaxy room (asteroid mix,
   *  nebula for Gas Collectors). Galaxy rooms use their sector's features. */
  sectorFeatures?: AsteroidFieldFeature[];
  /** How many drones to seed at room start. 0 to skip. Defaults to 30 for non-test rooms. */
  droneCount?: number;
  /** Spawn-ring radius for the drone wave (legacy small-seed path —
   *  ignored when `swarmCount` is set). Defaults to 150 u so a player
   *  spawning at origin can engage immediately. Earlier the default was
   *  350 u, but smoke testing the network-feel roadmap repeatedly
   *  needed enemies in range without a long drive — this is the knob. */
  droneRadius?: number;
  /**
   * Phase 5e: bulk-seed N entities (asteroids + drones in `swarmRatio`
   * mix) instead of using `asteroidConfig` + `droneCount`. When set,
   * suppresses both legacy paths so we don't double-spawn.
   */
  cutField?: { seed: string; clearings?: FieldClearing[] }; // macro terrain v2: test/showcase rooms, and every asteroid-marked galaxy sector via resolveSectorConfig (F4, with pocket clearings; docs/architecture/macro-terrain.md)
  /** Wreck fields 3b: an old battlefield's hulls streamed in by chunk
   *  (`WreckFieldSource`). Off by default; dev room `wreck-field-test`. */
  wreckField?: WreckFieldRoomOpts;
  swarmCount?: number;
  swarmRatio?: number; // asteroid fraction; default 0.8
  swarmRadius?: number; // spawn disc radius; default 18 000
  /** Bulk-seeded rocks start still at the real asteroid mass, so they
   *  settle and sleep (terrain stress scenes, macro-terrain.md). */
  swarmAtRest?: boolean;
  /** Deterministic ship-kind sequence for drone spawns. When set, each
   *  successive drone takes the next kind in this array (round-robin
   *  past the end). Used by engineering rooms (`mount-test`) that need
   *  a known mix of multi-mount drones for Phase 4c smoke testing.
   *  When undefined, the spawner falls back to uniform-random
   *  `pickRandomShipKind`. */
  droneKinds?: ShipKindId[];
  /**
   * 2026-05-27 — Engineering test rooms (`shield-test`) want a
   * stationary drone gallery: ram them, shoot them, watch the
   * shield-vs-hull collider swap, WITHOUT having them fly around
   * pursuing + firing back. When true, drones spawn with
   * `PassiveDroneBehaviour` (zero-impulse, never-fire) instead of
   * `HostileDroneBehaviour`. Drones still take damage and die
   * normally; only the COMBAT state transition (pursuit + fire)
   * is suppressed. */
  peacefulDrones?: boolean;
  /** Test mode only: deaths keep every stack (no EVE coin flip), for
   *  tests that pin exact pod contents. */
  keepAllOnDeath?: boolean;
  /**
   * Phase 5e sleep handshake test mode. Spawns exactly one stationary
   * asteroid at a known position so the test can observe its sleep
   * transition. Suppresses every other seed path.
   */
  singleAsteroid?: boolean;
  /**
   * Phase 6 — synthetic per-tick CPU burn (in ms) injected into the
   * server `update()`. Used to deterministically push the tick budget
   * past `OVER_BUDGET_MS` so the SimulationClock ramps to its 0.7×
   * floor without needing tens of thousands of entities (which would
   * crash the Rapier WASM pool). 0 / undefined = disabled.
   */
  tickBurnMs?: number;
  /**
   * Phase 8 — stable galaxy sector key (e.g. 'sol-prime'). Set for the
   * 7 galaxy rooms registered at boot from GALAXY_SECTORS; left undefined
   * for engineering rooms (test-sector, swarm-*) which have no persistent
   * identity. Drives persistence-row scoping, the `welcome.sectorKey`
   * field, and (sub-phase B) Limbo / transit eligibility.
   */
  sectorKey?: string;
  /**
   * Engineering test rooms (e.g. `feel-test`) want every player to spawn
   * at a known anchor, not the default ±200 u random scatter. When set,
   * these are used instead of the random fallback at `onJoin`. URL-param
   * `spawnX`/`spawnY` (in the join schema) still wins if a test client
   * passes them explicitly — so individual specs can override the room
   * default for adversarial scenarios.
   */
  defaultSpawnX?: number;
  defaultSpawnY?: number;
  /** Test-only physics-tick acceleration. The worker already scales
   *  its physics-step accumulator by the SAB-resident clock rate
   *  (Phase 6 TiDi — `physics.tick(FIXED_DT * rate)`); setting this
   *  to e.g. 10 in a `testMode` room multiplies the outbound rate
   *  by 10 so 1 wall-clock tick advances 10 physics ticks of game
   *  time. Ghost-TTL (500 ms), projectile lifetime (4 s), warp
   *  spool (30 s), regen cycles all compress proportionally.
   *  Ignored on non-testMode rooms (galaxy gameplay never sees a
   *  multiplied clock). Server-side `state.clockRate` continues to
   *  report the unmultiplied `simClock.rate` so client audio pitch
   *  + TiDi UI stay honest. */
  testTimeScale?: number;
  /**
   * 2026-05-28 — test-only: gate the entire ramming-damage path. The
   * damage formula in `core/combat/Ramming.ts` is impact-speed gated
   * (`RAM_MIN_IMPACT_SPEED` u/s below which damage is 0), and a real
   * ram quickly caps the player at the per-pair `RAM_DAMAGE_MAX = 50`
   * HP/tick. `ramming-probe-test` needs the player to ram a target
   * to gather visual-vs-physics frames WITHOUT dying. When this
   * flag is true the `onContactBatch` path skips the `applyDamage`
   * call (server still broadcasts `collision_resolved` for velocity
   * sync; `ram_damage` is suppressed and no health changes). Ignored
   * on non-testMode rooms.
   */
  disableCollisionDamage?: boolean;
  /**
   * 2026-05-28 — Engineering-test rooms (`hull-collision-test`) seed a
   * deterministic gallery of drones at hand-authored poses, bypassing the
   * uniform-disc spawner. Each entry forces the drone to a specific
   * world `(x, y, angle)`; `hullExposed: true` immediately drops the
   * shield + posts `SET_HULL_EXPOSED` so the hull-polygon collider is
   * exposed at spawn (no need to ram + drain shield first).
   *
   * Suppresses `useBulkSeed` / asteroidRoster / legacy drone-wave seed
   * paths — no double-spawn. Ignored on non-testMode rooms; bypasses
   * `peacefulDrones` AI selection (the room-level option still applies
   * to the AI factory). Drones still take damage and die normally.
   */
  dronePoses?: ReadonlyArray<{
    kind: ShipKindId;
    x: number;
    y: number;
    angle?: number;
    /** Initial velocity (u/s), e.g. a capital already under way. */
    vx?: number;
    vy?: number;
    hullExposed?: boolean;
    /** Radar sandbox (plan sparkling-wondering-rose) — fly a scripted
     *  straight line from the pose to `(toX, toY)` at `speed` u/s,
     *  ping-ponging unless `loop:false`. Replaces this drone's AI with
     *  `ScriptedPathBehaviour` (no combat). */
    path?: { toX: number; toY: number; speed: number; loop?: boolean };
    /** Radar sandbox — mark this drone hostile to every joining player (so
     *  it renders as a hostile contact) without it attacking anything. */
    hostile?: boolean;
    /** Showcase — make this drone a named elite with a bounty (as the
     *  EliteDirector would), so a bounty kill can be staged on cue. */
    elite?: { name: string; healthMul?: number; bounty?: number };
  }>;
  /**
   * Generic Entity Pipeline P4 — deterministic STRUCTURE placement. Each
   * entry spawns a static, damageable structure (pose-core kind byte 2) at
   * a world `(x, y)`, seeding `swarmHealth` so it takes damage through the
   * EXISTING swarm path (zero new dispatch). testMode-only; suppresses the
   * legacy asteroid roster like `dronePoses`. Drives the `structureEntity`
   * integration + `structure-visible-damageable` E2E ("for free" proof).
   */
  structurePoses?: ReadonlyArray<{
    id?: string;
    x: number;
    y: number;
    radius?: number;
    mass?: number;
  }>;
  /** Structures plan, Phase 3/4 — override the grid pulse interval (ms).
   *  testMode-only bespoke trigger so E2E can fast-forward construction +
   *  mining (the pulse is a wall-clock timer, NOT the physics tick, so
   *  `testTimeScale` doesn't speed it). Default `TRANSFER_PULSE_MS`. */
  structureGridPulseMs?: number;
  /** v4 T1 — teleporter jump-cycle speed (1 = real time; 0.01 runs the
   *  ~14 s cycle in ~140 ms). testMode-only bespoke trigger. */
  teleportCycleScale?: number;
  /** v4 T1 — pair the seeded teleporters in order (1st with 2nd, …).
   *  testMode-only. */
  pairTeleporters?: boolean;
  /** Showcase / tests: the seeded teleporters fire when a ship boards. */
  teleportShipBoards?: boolean;
  /** Showcase / tests: keep every teleporter's capacitor full (an NPC
   *  base's spare power is small, and a take must not wait on it). */
  teleportFullCharge?: boolean;
  /** Structures plan (Phase 3-5) — seed PRE-BUILT, auto-connected structures
   *  at hand-authored poses (owner `scenario`). testMode-only bespoke
   *  trigger: gives E2E a fully-functional powered grid without fighting the
   *  place-ahead UI (which stacks/overlaps multiple placements) or the
   *  construction wait. Each is born `isConstructed` at full HP. */
  prebuiltStructures?: ReadonlyArray<{ kind: StructureKindId; x: number; y: number; rot?: number; gateAccess?: GateAccess }>;
  /** Plan soft-leaping-truffle v2, A0 — seed a RULE-VALID structure lattice
   *  of `n` structures (+ an optional closed pylon fence) for scale
   *  measurement. Generated server-side from (n, seed), so it is not bound
   *  by the 64-entry seed cap. testMode-only. */
  scaleGrid?: { n: number; seed: number; fence?: boolean };
  /** D2 — NPC bases grown by the core generator (server-authored, never
   *  client input). Galaxy seeding of these comes with trade (phase T). */
  npcBases?: NpcBaseSpec[];
  /** T1 — grow this galaxy sector's own NPC base from its profile and
   *  seed it AFTER the snapshot restore (saved player structures keep
   *  their space). Set for every galaxy room by `resolveSectorConfig`. */
  galaxyBases?: boolean;
  /** v4 A — seed the Ancients' border gates (one per neighbour, twinned
   *  with the gate across the border). Set for every galaxy room. */
  alienGates?: boolean;
  /** Phase 4 — solar-system sector rules for THIS room (warp-to drop
   *  points). Defaults to the process switch `EQX_SOLAR_SECTORS`; tests
   *  set it explicitly, because the shared-module integration run reads
   *  the env switch once for every file. */
  solarSectors?: boolean;
  /** Wrap-up W1b — seed the system's transit-pad pair (`pocketPadPair`)
   *  when solar-system sectors are on. Defaults to `alienGates` (every
   *  galaxy room). */
  pocketPads?: boolean;
  /** v4 A — testMode: seed one alien gate here (no twin room), for E2E. */
  testAlienGate?: { x: number; y: number; neighbour: string };
  /** C2 bespoke trigger: every break-in takes this long (ms). testMode-only. */
  breakInMs?: number;
  /** Bespoke test/recording trigger: no NON-player lock takes longer than
   *  this (s); 0 = the first step. zod-checked; testMode-only. */
  lockTimeCapS?: unknown;
  /** Bespoke test trigger: no capital-turret charge takes longer than this
   *  (ticks). zod-checked; testMode-only. */
  chargeTicksCap?: unknown;
  /** Bespoke test trigger: no capital turret takes longer than this to
   *  train a full turn (ticks). zod-checked; testMode-only. */
  traverseTicksCap?: unknown;
  /** Game speed for this sector (0.25–4). zod-checked; testMode-only. */
  timeScale?: unknown;
  /** testMode: run the automatic slowdown here too (on by default only in
   *  real sectors). */
  autoTimeScale?: boolean;
  /** Capital destruction: a dying capital breaks into wreck bodies. ON
   *  by default (owner 2026-11-14); `false` opts this room out.
   *  `EQX_CAPITAL_WRECKS=0|1` forces it for every room (`wreckSwitchOn`). */
  capitalWrecks?: boolean;
  /** Sub-capital break-up: every other ship (polygon kinds; the composite
   *  havok keeps its scrap) breaks into 2-3 quiet wreck pieces that settle
   *  and sleep. ON by default (owner 2026-11-14); `false` opts this room
   *  out. `EQX_SUBCAP_WRECKS=0|1` forces it for every room. */
  subcapWrecks?: boolean; battleWreckStreaming?: boolean; // wreck fields 0b: a test room streams its saved battle wrecks (live rooms always do)
  /** Wave-system E2E — owner id for `prebuiltStructures` (default `scenario`).
   *  Set to the joining test player's id so the seeded base is a real
   *  player-owned faction the WaveDirector can target. testMode-only. */
  prebuiltStructuresOwner?: string;
  /** Economy v2 W5b — test rooms: switch the ship-picker hull gate on. */
  enforceHullGate?: boolean;
  /** Join flow — test rooms: launch prices on/off (default LAUNCH_COSTS_ON). */
  launchCosts?: boolean;
  /** P2d (testMode) — goods put into the prebuilt Capital's hold (e.g.
   *  munitions so a showcase's missile turrets can fire). */
  prebuiltStorageGoods?: Partial<Record<GoodId, number>>;
  /** Base loop (testMode) — minerals banked in the prebuilt Capital (what
   *  construction draws), capped at its storage. */
  prebuiltCapitalMinerals?: number;
  /** Living World P2 — testMode: join the TradeDirector so deals can be
   *  made in this (non-galaxy) room (showcase / E2E). */
  tradeEnabled?: boolean;
  /** Living World P2 — testMode: a storage structure PLACED in this room
   *  starts with this hold (trade E2E / showcase). */
  seedStorageHold?: { goods: Partial<Record<'minerals' | 'salvage' | 'alloy' | 'core', number>>; credits?: number };
  /** Living World P2 — testMode: when a trade hauler enters this room, this
   *  many robot cubes appear partway along its route (the raid on camera). */
  haulerRaiders?: number;
  /** Structures plan (Phase 5) — park idle drones at poses (turret targets).
   *  testMode-only; for the turret-fires scenario. */
  scenarioDrones?: ReadonlyArray<{ x: number; y: number }>;
  /** Structures plan (Phase 4) — seed asteroids at poses (miner targets).
   *  testMode-only; for the mining scenario. */
  scenarioAsteroids?: ReadonlyArray<{ x: number; y: number; radius?: number }>;
  /** Phase-1 issue 5 — seed N free-floating SCRAP pieces in a dense corridor
   *  AHEAD of spawn (+y), via the real `SectorSnapshotRestore.restoreScrap` path, so an
   *  E2E can fly the player straight through a scrap cascade and measure
   *  prediction corrections/drift. testMode-only. Drives `scrap-stress-test`.
   *  See `tests/e2e/scrap-collision-stress.spec.ts`. */
  scenarioScrapCount?: number;
  /** Wave-system (2026-06-10) — override the PLAYER warp spool (ms). The
   *  production default is `SPOOL_DURATION_MS` (5 min); E2E can't wait that
   *  long, so testMode rooms inject e.g. 2_000. testMode-only. NOTE: this
   *  reaches the player `TransitOrchestrator` only — drone-squad spool is
   *  driven by the director's own `spoolMs` option / `EQX_BOT_SPOOL_MS`. */
  transitSpoolMsOverride?: number;
  /** Perf scenes (plan prancy-squishing-donut P1) — a timed list of world
   *  events (`SceneScriptRunner`), started when the first pilot is ready.
   *  testMode-only. */
  sceneScript?: unknown;
  /** Perf scenes — no TiDi and no load shedding, so the work stays fixed
   *  and an overload shows as slower ticks. testMode-only. */
  perfFixedLoad?: boolean;
  /** testMode — false: never save or restore this sector's snapshot (a
   *  test room that needs a sectorKey for the roster, not persistence). */
  persistSector?: boolean;
  /** testMode — where a WAVE squad lands in this room (the wave E2E;
   *  `LivingWorldRoom.testWaveArrival`). */
  testWaveArrival?: { x: number; y: number };
  /** testMode — a base here is wave-ready only while its owner has an
   *  active ship in the room, so a wave E2E draws its wave after it joins,
   *  however long the server ran before (waves otherwise ignore presence). */
  waveNeedsOwner?: boolean;
}
