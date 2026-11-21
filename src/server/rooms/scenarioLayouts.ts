/**
 * Hand-authored structure layouts for test / scenario rooms (plan
 * soft-leaping-truffle v2, phase V). ONE source shared by the room
 * definitions in `src/server/index.ts` and the integration tests, so the
 * footprint-correct geometry is derived once.
 *
 * Footprints (catalogue v9): Capital 560×560, Connector 64×64, Solar 360×150,
 * Miner 240×240, Turret 140×140. Rules every layout here satisfies: no
 * overlapping boxes, every link ≤ 600 u edge-to-edge with clear line of
 * sight, the Capital links only to Connectors (max 4).
 *
 * The standard powered grid ("structure scenario"):
 *
 *           Solar NW (-250, 400)   Connector N (0, 350)   Solar NE (250, 400)
 *                    Bay  Capital (0, 0) rot 90
 *           Miner SW (-200, -420)  Connector S (0, -350)  Turret SE (150, -400)
 *
 *   Capital 50 + 2 Solars 60 − Miner 60 − Turret 15 = +35 ⇒ powered.
 *   An asteroid sits in the Miner's range; a drone in the Turret's range.
 *   The Capital is turned 90° so its crane bay (structure-restyle 3i, its
 *   `keepClear` pad) opens WEST onto empty space: at rot 0 the pad covers
 *   Connector N and both Solars and placement drops them (`overlap-pad`).
 *   `prebuiltLayouts.test.ts` guards every layout here.
 *
 * Also here: applying a layout (`seedStructureScenario`, the testMode room
 * opts), the scale lattice (`seedScaleGrid`), the scrap corridor
 * (`seedScenarioScrap`) and the pre-A2 structure row test view
 * (`structureRowsForTests`). The room's boot-time swarm seed
 * (`seedRoomStartup`) lives in `roomStartupSeed.ts`.
 */

import type { GoodId } from '../../shared-types/goods.js';
import { starterJunkCopies } from '../economy/starterGrant.js';
import { makeBlueprint } from '../../shared-types/blueprints.js';
import { RECIPES, blueprintProductFor, type RecipeId } from '../../shared-types/recipes.js';
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { gateAccessIndex, GATE_ACCESS_IDS, type GateAccess } from '../../shared-types/gateAccess.js';
import { type ShipKindId } from '../../shared-types/shipKinds.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import {
  STRUCTURE_ETA_NONE,
  decodeBuildEta,
  STRUCTURE_FLAG_BUILT,
  STRUCTURE_FLAG_DECONSTRUCTING,
  STRUCTURE_FLAG_POWERED,
  STRUCTURE_FLAG_WALL_ACTIVE,
  STRUCTURE_TARGET_NONE,
  STRUCTURE_DEFAULTS as SD,
} from '../../shared-types/structureStateWire.js';
import { DEFAULT_TELEPORT_RULES, isTeleporterKind } from '../../shared-types/teleport.js';
import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import { buildStructureLattice } from '../../core/structures/structureLattice.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import type { TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';
import { buildGridNodes, connectExplicit } from '../structures/structureGridView.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';
import type { SectorSnapshotScrap } from './SectorSnapshot.js';

export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * Gates E2E / showcase base: a powered Capital with two Shield Gates south of
 * it, side by side. The WEST gate opens for anyone not hostile; the EAST gate
 * opens for its owner only — and the owner is `scenario`, so a visiting pilot
 * is locked out. Ships spawned south of a gate and flown north (+y) test both.
 * Power: Capital 50 + Solar 120 ≥ 2 gates × 30. The Capital is turned 90°
 * so its crane bay pad (west) clears the north Connector and Solar.
 */
export const GATE_TEST = {
  openGate: { x: -400, y: -900 },
  lockedGate: { x: 400, y: -900 },
} as const;

export const GATE_TEST_PREBUILT = [
  { kind: 'capital', x: 0, y: 0, rot: 90 },
  { kind: 'connector', x: 0, y: 350 },
  { kind: 'solar', x: 450, y: 500 },
  { kind: 'connector', x: 0, y: -350 },
  { kind: 'shield_gate', ...GATE_TEST.openGate, gateAccess: 'open' },
  { kind: 'shield_gate', ...GATE_TEST.lockedGate, gateAccess: 'owner' },
] as const;

export const SCENARIO = {
  /** Turned 90°: its crane bay pad faces west, centre world (-410, 0). */
  capital: { x: 0, y: 0, rot: 90 },
  connectorN: { x: 0, y: 350 },
  connectorS: { x: 0, y: -350 },
  /** 700 u wide: each stands clear of the north Connector on its side. */
  solarNE: { x: 450, y: 500 },
  solarNW: { x: -450, y: 500 },
  minerSW: { x: -200, y: -420 },
  turretSE: { x: 150, y: -400 },
  /** In the Miner's 800 u range (≈ 573 u away). */
  asteroid: { x: -700, y: -700, radius: 30 },
  /** In the Turret's 600 u range (550 u below it). */
  drone: { x: 150, y: -950 },
} as const;

/** The full powered scenario grid, in an order auto-connect wires correctly
 *  (hubs before their leaves). */
export const STRUCTURE_SCENARIO_PREBUILT = [
  { kind: 'capital', ...SCENARIO.capital },
  { kind: 'connector', ...SCENARIO.connectorN },
  { kind: 'connector', ...SCENARIO.connectorS },
  { kind: 'solar', ...SCENARIO.solarNE },
  { kind: 'solar', ...SCENARIO.solarNW },
  { kind: 'miner', ...SCENARIO.minerSW },
  { kind: 'turret', ...SCENARIO.turretSE },
] as const;

/** `base-build-test` (Sunday base loop): the scenario's Capital, its north
 *  Connector and both Solars — a small powered starter base and nothing else
 *  (no Miner, Turret or rock beside it), so the pilot has open space to place
 *  more. The same proven, auto-connecting positions as the full grid. */
export const BASE_BUILD_PREBUILT = [
  { kind: 'capital', ...SCENARIO.capital },
  { kind: 'connector', ...SCENARIO.connectorN },
  { kind: 'solar', ...SCENARIO.solarNE },
  { kind: 'solar', ...SCENARIO.solarNW },
] as const;

/** Placeholder owner of a prebuilt base that the FIRST pilot to join adopts
 *  (`base-build-test`): the base then belongs to whoever really joined —
 *  whatever id the server resolved for them (account, fresh anonymous id) —
 *  so their placed blueprints cable to it and draw its bank. */
export const PREBUILT_ADOPT_OWNER = 'prebuilt-adopt';

/** Hand every structure still owned by `PREBUILT_ADOPT_OWNER` to
 *  `playerId` and re-cable (the next grid pulse rebuilds the topology and the
 *  client slice re-interns the owner). Returns how many were adopted; 0 once
 *  the base has an owner, so only the first joiner gets it. */
export function adoptPrebuiltBase(reg: StructureRegistry, playerId: string): number {
  let n = 0;
  for (const rec of reg.all()) {
    if (rec.owner !== PREBUILT_ADOPT_OWNER) continue;
    rec.owner = playerId;
    n++;
  }
  if (n > 0) reg.topologyDirty = true;
  return n;
}

/** A "ready base" for the wave system (Capital + Miner + Solar + Turret,
 *  wired through the two connectors) — the same grid. */
export const READY_BASE_PREBUILT = STRUCTURE_SCENARIO_PREBUILT;

/**
 * Articulation sandbox (structure-restyle 2f, plan §5): a small outpost, a
 * freight dock (its crane rig and loading pad, open side +y) and a turret
 * (its hatch + pop-up rig) beside it, both at rot 0 so host frame = world
 * offset. Power: a Capital (50; a grid is powered only with a Capital in it)
 * south-east of the turret, away from the pad and out of the wide shot, and a
 * Connector between them (the Capital links only to Connectors) feed the dock
 * (15) and the turret (15), so nothing shows the unpowered marker and the
 * turret deploys powered. A scripted trader hauler flies onto the pad and the crane reaches
 * for it (`rigClip` scene steps: the swarm hauler has no owner, so the bay
 * dwell, `CraneBays.dockDwell`, does not serve it). Times are ms after the first pilot is ready; the scene
 * starts after `lead` so a take can be rolling first.
 */
export const RIG_SANDBOX = {
  dock: { x: 0, y: 0 },
  /** Pad centre (dock host frame (0, 460)). */
  pad: { x: 0, y: 460 },
  /** The pad's far west corner, the hauler's off-centre berth. */
  padCorner: { x: -380, y: 640 },
  turret: { x: 720, y: 0 },
  /** Grid hub just south of the turret (its top edge in the turret close-up). */
  connector: { x: 720, y: -160 },
  /** The power source, south-east of the connector, clear of the wide shot. */
  capital: { x: 800, y: -560 },
  haulerEntry: { x: 0, y: 1700 },
} as const;

/** Hubs first, so the leaves auto-connect to them. */
export const RIG_SANDBOX_PREBUILT = [
  // Turned 180°: its crane bay pad (3i) faces away from the connector.
  { kind: 'capital', ...RIG_SANDBOX.capital, rot: 180 },
  { kind: 'connector', ...RIG_SANDBOX.connector },
  { kind: 'freight_dock', ...RIG_SANDBOX.dock },
  { kind: 'turret', ...RIG_SANDBOX.turret },
] as const;

/** The filmed timeline (≈ 27 s after `lead`). */
export function rigSandboxScene(lead: number): unknown[] {
  const t = (s: number): number => Math.round(lead + s * 1000);
  const H = 'hauler';
  return [
    // 0. Before the take rolls: the turret (idling deployed) packs away, so
    //    step 4 starts from the shut hatch.
    { atMs: 0, action: 'rigClip', structure: 'turret', clip: 'turret-retract' },
    // 1. Fly in, stop on the pad; after ~1 s the crane reaches, holds, retracts; out.
    { atMs: t(0), action: 'spawn', tag: H, kind: 'trader-hauler', count: 1, ...RIG_SANDBOX.haulerEntry },
    { atMs: t(0), action: 'move', tag: H, ...RIG_SANDBOX.pad, speed: 320 },
    { atMs: t(5.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(6.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-hold', keepTarget: true },
    { atMs: t(8.5), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', keepTarget: true },
    { atMs: t(9.5), action: 'move', tag: H, x: -700, y: 1150, speed: 320 },
    // 2. Edge case: parked at the pad's far corner; the crane still reaches.
    { atMs: t(12.8), action: 'move', tag: H, ...RIG_SANDBOX.padCorner, speed: 280 },
    { atMs: t(16.2), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(18.2), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', keepTarget: true },
    // 3. Abort: the hauler leaves mid-reach; the crane retracts from where it is.
    { atMs: t(19.6), action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: H },
    { atMs: t(20.0), action: 'move', tag: H, x: -700, y: 1400, speed: 320 },
    { atMs: t(20.1), action: 'rigClip', structure: 'freight_dock', clip: 'arm-retract', fromTip: true },
    // 4. The turret: hatch open + shut, then the turret deploys and retracts.
    // The retract above ends at ~21.1 s; a camera pan keyed to the scene
    // clock (`GET /dev/perf` scene.elapsedMs) at ~21.6 s lands before 23.5 s.
    { atMs: t(23.5), action: 'rigClip', structure: 'turret', clip: 'door-open' },
    { atMs: t(24.8), action: 'rigClip', structure: 'turret', clip: 'door-close' },
    { atMs: t(26.0), action: 'rigClip', structure: 'turret', clip: 'turret-deploy' },
    { atMs: t(28.5), action: 'rigClip', structure: 'turret', clip: 'turret-retract' },
    { atMs: t(31.0), action: 'end' },
  ];
}

/**
 * structure-restyle 3b film: the same outpost with NO script. The player owns
 * the dock (`prebuiltStructuresOwner`); a film joins south of the pad, nose to
 * the dock (`?spawnX=0&spawnY=1500&initialAngle=3.1416`), with a load aboard (`?initialCargo=`; the hold
 * needs a roster-bound hull, hence the `sectorKey`). Flying onto the bay and
 * stopping is all it takes: the real bay dwell (`CraneBays.dockDwell`) runs
 * the crane and banks the load.
 */
export const RIG_UNLOAD = {
  sectorKey: 'showcase-rig-unload',
} as const;

/**
 * structure-restyle 3i stills: "first load home". The pilot's own Capital
 * alone at (0, 0); its built-in crane bay is past its +y edge (pad centre
 * (0, 410)). A film joins south with a load aboard
 * (`?spawnX=0&spawnY=1600&initialAngle=3.1416&initialCargo=`), flies onto the
 * bay and stops; the real bay dwell runs the Capital's crane.
 */
export const RIG_HOME = {
  sectorKey: 'showcase-rig-home',
  prebuiltStructures: [{ kind: 'capital', x: 0, y: 0 }],
} as const;

/** E2E: the hauler is already on the pad and the crane reaches at once. */
export const RIG_SANDBOX_E2E_SCENE: unknown[] = [
  { atMs: 0, action: 'spawn', tag: 'hauler', kind: 'trader-hauler', count: 1, ...RIG_SANDBOX.pad },
  { atMs: 200, action: 'rigClip', structure: 'freight_dock', clip: 'arm-reach', targetShip: 'hauler' },
];
/** Room opts read by `seedStructureScenario` (testMode only). */
export interface StructureScenarioOpts {
  prebuiltStructures?: ReadonlyArray<{ kind: ShipKindId | string; x: number; y: number; rot?: number; gateAccess?: GateAccess; recipe?: RecipeId }>;
  prebuiltStructuresOwner?: string;
  prebuiltStorageGoods?: Partial<Record<GoodId, number>>;
  prebuiltCapitalMinerals?: number;
  prebuiltStarterBlueprints?: boolean;
  pairTeleporters?: boolean;
  teleportShipBoards?: boolean;
  scenarioDrones?: ReadonlyArray<{ x: number; y: number }>;
  scenarioAsteroids?: ReadonlyArray<{ x: number; y: number; radius?: number }>;
}

/** What `seedStructureScenario` reads from the room; getters for the fields
 *  the room assigns in `onCreate`. */
export interface StructureScenarioHost {
  structureRegistry: StructureRegistry;
  logger: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  structurePlacement: () => Pick<StructurePlacementSubsystem, 'place'>;
  teleporters: () => Pick<TeleporterSubsystem, 'pair'>;
  swarmSpawner: () => Pick<SwarmSpawner, 'spawnAsteroid' | 'spawnDrone'>;
  swarmHealth: () => Map<string, number>;
  swarmShield: () => Map<string, number>;
  structureGridTick: () => void;
}

/**
 * Seed a PRE-BUILT, auto-connected, powered grid + parked drones + asteroids
 * from the room opts (owner `scenario` unless `prebuiltStructuresOwner`),
 * through the same `structurePlacement.place` seam players and the snapshot
 * restore use. The caller gates it on testMode; runs once at `onCreate`.
 */
export function seedStructureScenario(h: StructureScenarioHost, roomOpts: StructureScenarioOpts): void {
  const prebuilt = roomOpts.prebuiltStructures;
  // Wave-system E2E: an explicit owner lets a test seed a base the joining
  // player OWNS (so the FactionLedger sees a player-owned faction the
  // WaveDirector can wave) instead of the inert `scenario` owner. Default
  // `scenario` preserves the structure-scenario-test behaviour.
  const owner = roomOpts.prebuiltStructuresOwner ?? 'scenario';
  if (prebuilt && prebuilt.length > 0) {
    for (const ps of prebuilt) {
      const extra = ps as { rot?: number; gateAccess?: GateAccess; recipe?: RecipeId };
      const id = h.structurePlacement().place(owner, ps.kind as string, ps.x, ps.y, { rot: extra.rot });
      if (id === null) {
        h.logger.warn({ kind: ps.kind, x: ps.x, y: ps.y }, 'scenario prebuilt structure rejected');
        continue;
      }
      const rec = h.structureRegistry.get(id);
      if (rec && extra.gateAccess && GATE_ACCESS_IDS.includes(extra.gateAccess)) {
        rec.gateAccess = gateAccessIndex(extra.gateAccess);
      }
      // A processor already on a recipe (perf `base-loop`: a Shipyard building),
      // a junk copy in its slot as a player loads one (`StorageService.loadBlueprint`).
      if (rec && extra.recipe !== undefined) {
        rec.recipe = extra.recipe;
        if (RECIPES[extra.recipe].blueprintRequired) rec.blueprint = makeBlueprint(blueprintProductFor(extra.recipe), 'bpc', Math.random, { junk: true });
      }
      if (rec && !rec.isConstructed) {
        rec.isConstructed = true;
        rec.constructionProgress = rec.constructionCost;
        h.swarmHealth().set(id, getStructureKind(rec.kind).maxHealth);
      }
    }
    h.structureRegistry.topologyDirty = true;
    // P2d — stock the prebuilt Capital (e.g. munitions for a showcase's
    // missile turrets), so ammo-using turrets can fire.
    const goods = roomOpts.prebuiltStorageGoods;
    // Base loop — fill the prebuilt Capital's mineral BANK (`minerals`, what
    // construction draws; not its goods hold), capped at its storage.
    const bank = Math.max(0, Math.floor(roomOpts.prebuiltCapitalMinerals ?? 0));
    if (bank > 0) {
      const cap = [...h.structureRegistry.all()].find((r) => r.owner === owner && r.kind === 'capital');
      if (cap) cap.minerals = Math.min(bank, getStructureKind('capital').storageCapacity);
    }
    // Base loop — the starter junk blueprint copies (the starter grant's
    // items, starterGrant.ts) in the prebuilt Capital's hold.
    if (roomOpts.prebuiltStarterBlueprints === true) {
      const cap = [...h.structureRegistry.all()].find((r) => r.owner === owner && r.kind === 'capital');
      if (cap) (cap.hold ??= { goods: {}, blueprints: [] }).blueprints.push(...starterJunkCopies());
    }
    if (goods) {
      for (const rec of h.structureRegistry.all()) {
        if (rec.owner !== owner || rec.kind !== 'capital') continue;
        rec.hold ??= { goods: {}, blueprints: [] };
        for (const [g, n] of Object.entries(goods)) rec.hold.goods[g as GoodId] = (rec.hold.goods[g as GoodId] ?? 0) + (n ?? 0);
        break;
      }
    }
    // v4 T1 — pair the seeded teleporters in order (1st with 2nd, …).
    if (roomOpts.pairTeleporters === true) {
      const tps = [...h.structureRegistry.all()].filter((r) => r.owner === owner && isTeleporterKind(r.kind));
      for (let i = 0; i + 1 < tps.length; i += 2) h.teleporters().pair(tps[i]!, tps[i + 1]!);
      if (roomOpts.teleportShipBoards === true) {
        for (const t of tps) t.tpRules = { ...DEFAULT_TELEPORT_RULES, shipBoards: true };
      }
    }
    // One pulse rebuilds the grid (powered components) + refreshes the slice.
    h.structureGridTick();
  }
  let scenarioSwarmId = 0;
  for (const a of roomOpts.scenarioAsteroids ?? []) {
    h.swarmSpawner().spawnAsteroid({
      id: `scenario-rock-${scenarioSwarmId++}`, x: a.x, y: a.y, vx: 0, vy: 0, radius: a.radius ?? 30, mass: 1,
    });
  }
  for (const d of roomOpts.scenarioDrones ?? []) {
    const droneId = `scenario-drone-${scenarioSwarmId++}`;
    if (h.swarmSpawner().spawnDrone({ id: droneId, x: d.x, y: d.y, kind: 'fighter' })) {
      h.swarmHealth().set(droneId, getDroneMaxHealth('fighter') ?? 40);
      h.swarmShield().set(droneId, 0); // hull exposed so turret damage lands
    }
  }
}

/** What `seedScaleGrid` reads from the room (a slice of the structure scenario host). */
export type ScaleGridHost = Pick<StructureScenarioHost, 'structureRegistry' | 'structurePlacement' | 'swarmHealth' | 'structureGridTick' | 'logger'>;

/**
 * A0 scale lattice: place every structure WITHOUT greedy auto-connect, then
 * apply the lattice's intended edges through `connectExplicit` (the real
 * `canConnect` re-checked), force-build, and run one grid tick. Owner
 * `scenario`. Rejections are counted and logged — the lattice is rule-valid
 * by construction (structureLattice.test.ts), so any rejection is a bug.
 */
export function seedScaleGrid(h: ScaleGridHost, opts: { n: number; seed: number; fence?: boolean }): void {
  const n = Math.max(1, Math.min(4000, Math.floor(opts.n)));
  const lat = buildStructureLattice({ n, seed: opts.seed, fence: opts.fence === true });
  const ids: Array<string | null> = [];
  let rejectedPlace = 0;
  for (const p of lat.placements) {
    const id = h.structurePlacement().place('scenario', p.kind, p.x, p.y, { skipAutoConnect: true, rot: p.rot });
    if (id === null) rejectedPlace++;
    ids.push(id);
    const rec = id ? h.structureRegistry.get(id) : undefined;
    if (rec && !rec.isConstructed) {
      rec.isConstructed = true;
      rec.constructionProgress = rec.constructionCost;
      h.swarmHealth().set(rec.id, getStructureKind(rec.kind).maxHealth);
    }
  }
  const nodes = buildGridNodes(h.structureRegistry);
  let rejectedEdge = 0;
  for (const [a, b] of lat.edges) {
    const ia = ids[a], ib = ids[b];
    if (!ia || !ib || !connectExplicit(h.structureRegistry, ia, ib, nodes)) rejectedEdge++;
  }
  h.structureRegistry.topologyDirty = true;
  h.structureGridTick();
  h.logger.info(
    { n, placed: lat.placements.length - rejectedPlace, edges: lat.edges.length, rejectedPlace, rejectedEdge, fencePylons: lat.fencePylons },
    'scale lattice seeded',
  );
}

/** What `seedScenarioScrap` reads from the room. */
export interface ScenarioScrapHost {
  logger: { info(obj: object, msg: string): void };
  restoreScrap(rows: SectorSnapshotScrap[]): void;
}

/**
 * Phase-1 issue 5 — seed `count` free-floating scrap pieces in a dense
 * corridor AHEAD of spawn (+y, the forward dir at angle 0), via the SAME
 * `SectorSnapshotRestore.restoreScrap` path the persistence layer uses (so the bodies
 * are byte-identical to real death-spawned scrap). The player flies straight
 * through this for the reconciliation stress E2E. testMode-only.
 */
export function seedScenarioScrap(h: ScenarioScrapHost, count: number): void {
  const PARENT = 'havok' as ShipKindId; // a composite kind with scrap groups
  const groups = shipScrapGroups(PARENT).length;
  if (groups === 0) return;
  const COLS = 7;
  const COL_SPACING = 48; // dense wall — a straight flight can't avoid clipping many
  const ROW_SPACING = 60;
  const Y0 = 250; // first row ahead of spawn, clear of the hull
  const rows: SectorSnapshotScrap[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    rows.push({
      entityId: `scrap-stress-${i}`,
      x: (col - (COLS - 1) / 2) * COL_SPACING,
      y: Y0 + row * ROW_SPACING,
      vx: 0,
      vy: 0,
      angle: 0,
      health: 30,
      parentShipKind: PARENT,
      componentIndex: i % groups,
    });
  }
  h.restoreScrap(rows);
  h.logger.info({ requested: count, parent: PARENT, groups }, 'scenario scrap seeded');
}

/** The pre-A2 per-structure row (test view — see `structureRowsForTests`). */
export interface StructureRowView {
  id: number;
  hpPct: number;
  powered: boolean;
  netPower: number;
  owner: string;
  built: boolean;
  ownerName?: string;
  level?: number;
  connTo?: number[];
  minerals?: number;
  buildPct?: number;
  etaMs?: number | null;
  isDeconstructing?: boolean;
  deconstructPct?: number;
  miningTargetId?: number;
  turretTargetId?: number;
  storedPower?: number;
  storedPowerMax?: number;
  shieldWallTo?: number;
  wallActive?: boolean;
}

/** The room state `structureRowsForTests` reads (`SectorState`'s structure
 *  maps), typed structurally: the showcase build imports this file and must
 *  not pull in the decorated schema. */
type StructureStateFields = 'ownerIdx' | 'flags' | 'hpPct' | 'netPower' | 'level' | 'minerals' | 'etaMs'
  | 'buildPct' | 'deconstructPct' | 'storedPower' | 'storedPowerMax' | 'shieldWallTo';
export interface StructureRowsState {
  structures: {
    readonly size: number;
    forEach(cb: (st: { [K in StructureStateFields]?: number } & { connTo: ArrayLike<number> & Iterable<number> }, key: string) => void): void;
  };
  structureOwners: { get(key: string): string | undefined };
  structureOwnerNames: { get(key: string): string | undefined };
}

/** Test view (`_internals.getStructuresSlice`): the pre-A2 row shape,
 *  rebuilt from room state + the targets slice (`[entityId, turretTarget,
 *  miningTarget]` triples). Allocates; test-only. */
export function structureRowsForTests(state: StructureRowsState, slice: readonly number[] | undefined): StructureRowView[] | undefined {
  const map = state.structures;
  if (map.size === 0) return undefined;
  const tgt = new Map<number, [number, number]>();
  const t = slice ?? [];
  for (let i = 0; i < t.length; i += 3) tgt.set(t[i]!, [t[i + 1]!, t[i + 2]!]);
  const rows: StructureRowView[] = [];
  map.forEach((st, key) => {
    const id = Number(key);
    const ownerKey = String(st.ownerIdx ?? SD.ownerIdx);
    const flags = st.flags ?? SD.flags;
    const row: StructureRowView = {
      id,
      hpPct: st.hpPct ?? SD.hpPct,
      powered: (flags & STRUCTURE_FLAG_POWERED) !== 0,
      netPower: st.netPower ?? SD.netPower,
      owner: state.structureOwners.get(ownerKey) ?? '',
      built: (flags & STRUCTURE_FLAG_BUILT) !== 0,
    };
    const ownerName = state.structureOwnerNames.get(ownerKey) ?? '';
    if (ownerName !== '') row.ownerName = ownerName;
    if ((st.level ?? SD.level) > 1) row.level = st.level;
    if (st.connTo.length > 0) row.connTo = Array.from(st.connTo);
    if ((st.minerals ?? SD.minerals) > 0) row.minerals = st.minerals;
    const eta = st.etaMs ?? SD.etaMs;
    if (eta !== STRUCTURE_ETA_NONE) {
      row.buildPct = st.buildPct ?? SD.buildPct;
      row.etaMs = decodeBuildEta(eta) ?? null;
    }
    if ((flags & STRUCTURE_FLAG_DECONSTRUCTING) !== 0) {
      row.isDeconstructing = true;
      row.deconstructPct = st.deconstructPct ?? SD.deconstructPct;
    }
    const tg = tgt.get(id);
    if (tg && tg[0] !== STRUCTURE_TARGET_NONE) row.turretTargetId = tg[0];
    if (tg && tg[1] !== STRUCTURE_TARGET_NONE) row.miningTargetId = tg[1];
    if ((st.storedPowerMax ?? SD.storedPowerMax) > 0) {
      row.storedPower = st.storedPower ?? SD.storedPower;
      row.storedPowerMax = st.storedPowerMax;
    }
    if ((st.shieldWallTo ?? SD.shieldWallTo) >= 0) {
      row.shieldWallTo = st.shieldWallTo;
      row.wallActive = (flags & STRUCTURE_FLAG_WALL_ACTIVE) !== 0;
    }
    rows.push(row);
  });
  return rows;
}

/** Perf scene `base-flow`: a working player base whose cables carry flow every
 *  grid pulse. The Capital (pad west) feeds three arms through connectors:
 *  north and south each hold two Miners on rocks plus a three-Solar spur, east
 *  is five Solars, turned on end (300 u wide). 1490 power for 240 of Miners,
 *  so every Miner drills and its minerals ride the cables to the Capital each
 *  second. */
function baseFlowArm(sy: 1 | -1): { kind: string; x: number; y: number }[] {
  return [
    { kind: 'connector', x: 0, y: 470 * sy },
    { kind: 'miner', x: -400, y: 800 * sy },
    { kind: 'miner', x: 400, y: 800 * sy },
    { kind: 'connector', x: 0, y: 1000 * sy },
    { kind: 'solar', x: -430, y: 1320 * sy },
    { kind: 'solar', x: 430, y: 1320 * sy },
    { kind: 'solar', x: 0, y: 1700 * sy },
  ];
}
export const BASE_FLOW_OPTS = {
  prebuiltStructures: [
    { kind: 'capital', x: 0, y: 0, rot: 90 },
    ...baseFlowArm(1),
    ...baseFlowArm(-1),
    { kind: 'connector', x: 470, y: 0 },
    { kind: 'solar', x: 800, y: -450, rot: 90 },
    { kind: 'solar', x: 800, y: 450, rot: 90 },
    { kind: 'connector', x: 1000, y: 0 },
    // The end Solar first: it needs an east face (one cable per connector socket).
    { kind: 'solar', x: 1700, y: 0, rot: 90 },
    { kind: 'solar', x: 1300, y: -450, rot: 90 },
    { kind: 'solar', x: 1300, y: 450, rot: 90 },
  ],
  prebuiltStructuresOwner: 'perf-base',
  /** One rock beside each Miner (≈ 460 u, inside its 800 u range). */
  scenarioAsteroids: [
    { x: -750, y: 1100, radius: 40 }, { x: 750, y: 1100, radius: 40 },
    { x: -750, y: -1100, radius: 40 }, { x: 750, y: -1100, radius: 40 },
  ],
};

/** Perf scene `base-loop`: the Sunday-loop base in sol-prime's belt clearing
 *  (r 4900; no rock inside). Capital (pad west) + 3 Solars, a Shipyard building an
 *  Interceptor (east), Refinery and Cargo Bay (south), a Turret and two Shield
 *  Pylons with their wall. 410 power for 280 used. The first joiner adopts it. */
export const BASE_LOOP_AT = { x: 96_626, y: 80_499 } as const;
const loop = (kind: string, x: number, y: number, more?: { rot?: number; recipe?: RecipeId }) =>
  ({ kind, x: BASE_LOOP_AT.x + x, y: BASE_LOOP_AT.y + y, ...more });
export const BASE_LOOP_OPTS = {
  prebuiltStructures: [
    loop('capital', 0, 0, { rot: 90 }), loop('connector', 0, 350), loop('connector', 0, -350), loop('connector', 420, 0),
    loop('solar', 450, 500), loop('solar', -450, 500), loop('solar', 450, -500),
    loop('shipyard', 1000, 0, { recipe: 'build_interceptor' }),
    loop('refinery', -450, -600), loop('connector', 0, -950), loop('cargo_bay', -400, -1100),
    loop('turret', 300, -1100), loop('shield_pylon', -350, -1450), loop('shield_pylon', 350, -1450),
  ],
  prebuiltStructuresOwner: PREBUILT_ADOPT_OWNER,
  prebuiltCapitalMinerals: CAPITAL_STARTING_MINERALS,
};
