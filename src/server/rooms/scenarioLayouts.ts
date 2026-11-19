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
 *                                   Capital (0, 0)
 *           Miner SW (-200, -420)  Connector S (0, -350)  Turret SE (150, -400)
 *
 *   Capital 50 + 2 Solars 60 − Miner 60 − Turret 15 = +35 ⇒ powered.
 *   An asteroid sits in the Miner's range; a drone in the Turret's range.
 *
 * Also here: applying a layout (`seedStructureScenario`, the testMode room
 * opts), the scale lattice (`seedScaleGrid`), the scrap corridor
 * (`seedScenarioScrap`) and the pre-A2 structure row test view (`structureRowsForTests`).
 */

import type { GoodId } from '../../shared-types/goods.js';
import { gateAccessIndex, GATE_ACCESS_IDS, type GateAccess } from '../../shared-types/gateAccess.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import {
  STRUCTURE_ETA_NONE,
  STRUCTURE_ETA_STALLED,
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
 * Power: Capital 50 + Solar 30 = 80 ≥ 2 gates × 30.
 */
export const GATE_TEST = {
  openGate: { x: -400, y: -900 },
  lockedGate: { x: 400, y: -900 },
} as const;

export const GATE_TEST_PREBUILT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: 0, y: 350 },
  { kind: 'solar', x: 250, y: 400 },
  { kind: 'connector', x: 0, y: -350 },
  { kind: 'shield_gate', ...GATE_TEST.openGate, gateAccess: 'open' },
  { kind: 'shield_gate', ...GATE_TEST.lockedGate, gateAccess: 'owner' },
] as const;

export const SCENARIO = {
  capital: { x: 0, y: 0 },
  connectorN: { x: 0, y: 350 },
  connectorS: { x: 0, y: -350 },
  solarNE: { x: 250, y: 400 },
  solarNW: { x: -250, y: 400 },
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

/** A "ready base" for the wave system (Capital + Miner + Solar + Turret,
 *  wired through the two connectors) — the same grid. */
export const READY_BASE_PREBUILT = STRUCTURE_SCENARIO_PREBUILT;

/** Room opts read by `seedStructureScenario` (testMode only). */
export interface StructureScenarioOpts {
  prebuiltStructures?: ReadonlyArray<{ kind: ShipKindId | string; x: number; y: number; rot?: number; gateAccess?: GateAccess }>;
  prebuiltStructuresOwner?: string;
  prebuiltStorageGoods?: Partial<Record<GoodId, number>>;
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
      const extra = ps as { rot?: number; gateAccess?: GateAccess };
      const id = h.structurePlacement().place(owner, ps.kind as string, ps.x, ps.y, { rot: extra.rot });
      if (id === null) {
        h.logger.warn({ kind: ps.kind, x: ps.x, y: ps.y }, 'scenario prebuilt structure rejected');
        continue;
      }
      const rec = h.structureRegistry.get(id);
      if (rec && extra.gateAccess && GATE_ACCESS_IDS.includes(extra.gateAccess)) {
        rec.gateAccess = gateAccessIndex(extra.gateAccess);
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
      row.etaMs = eta === STRUCTURE_ETA_STALLED ? null : eta;
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
