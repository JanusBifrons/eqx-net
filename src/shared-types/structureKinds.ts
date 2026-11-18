/**
 * Structure-kind catalogue — the single source of truth for placeable
 * power-grid structures (speed-dial-resource-structures plan, Phase 2).
 *
 * Modelled on the flash game *The Space Game* and the user's `eqx-peri` repo:
 * the player places structures, links them through hubs (Connectors / the
 * Capital), and a 1 Hz pulse moves power + minerals around the web. This file
 * is the structure analogue of [shipKinds.ts](./shipKinds.ts).
 *
 * Read by:
 *   - `src/server/structures/*` (placement validation, the grid pulse).
 *   - `src/server/net/BinarySwarmBroadcast.ts` (encodes a structure's subtype
 *     as the shared `shipKind` u8 byte when the pose-core `kind` is 2).
 *   - `src/client/net/BinarySwarmDecoder.ts` (decodes that byte back to an id).
 *   - `src/client/render/*` (silhouette + tint per subtype).
 *   - `src/client/structures/*` (the blueprint ghost + Build speed-dial menu).
 *
 * The records live in family files under `structureKinds/`; this file is a
 * barrel only — never add records here.
 *
 * **Invariant #11 (append-only).** `STRUCTURE_KINDS_LIST`
 * (`structureKinds/catalogueOrder.ts`) order is part of the binary swarm wire
 * format — a structure's subtype encodes as a `u8` index into this list
 * (sharing the `shipKind` byte that drones use). Adding a kind: add a record to
 * its family file + APPEND it to the list. NEVER reorder or remove — that
 * invalidates the index for in-flight packets and any persisted blueprint.
 *
 * Living in `src/shared-types/` (pure TS + zod, no runtime behaviour) is what
 * lets server / core / client all read the same definitions without violating
 * the boundary invariants.
 *
 * Reference values mirror eqx-peri's `STRUCTURE_DEFINITIONS` + The Space Game
 * (see `docs/plans/speed-dial-resource-structures.md`); tune for eqx-net world
 * scale during the build. Any numeric edit to an existing kind MUST bump
 * `STRUCTURE_KIND_CATALOGUE_VERSION`.
 */
export { TERRITORY_LOCK, TERRITORY_LOCK_COST } from './territoryLock.js';

export { StructureKindIdSchema, StructureKindSchema } from './structureKinds/types.js';
export type { StructureKindId, StructureKind } from './structureKinds/types.js';

export {
  CAPITAL, CARGO_BAY, CONNECTOR, SOLAR, MINER, TURRET, BATTERY, SHIELD_PYLON,
  LASER_BOLT_TURRET, MISSILE_TURRET, SHIELD_GATE, SHIELD_AIRLOCK,
} from './structureKinds/grid.js';
export {
  GAS_COLLECTOR, RECLAIMER, SMELTER, REFINERY, SILICON_WORKS, HYDROPONICS, FABRICATOR, MUNITIONS_WORKS,
  FREIGHT_DOCK, DEEP_CORE_RIG, ORE_PROCESSING_COMPLEX, ASSEMBLY_PLANT, RESEARCH_LAB, AUTOCANNON_TURRET,
} from './structureKinds/production.js';
export { REACTOR, BATTERY_BANK, STORAGE_VAULT, SHIPYARD } from './structureKinds/consolidated.js';
export {
  HABITAT_MODULE, TOWER_MODULE, MINE_LAYER, TELEPORTER, TELEPORTER_LARGE, ALIEN_GATE, POCKET_PAD,
} from './structureKinds/habitation.js';
export {
  AA_QUAD_40MM, DP_MOUNT_5IN, COASTAL_CASEMATE_8IN, COASTAL_TURRET_11IN, COASTAL_BARBETTE_16IN,
  COASTAL_LINDEMANN, SIEGE_GUN_80CM, COASTAL_DEFENCE_KINDS,
} from './structureKinds/coastal.js';

export { STRUCTURE_KINDS_LIST } from './structureKinds/catalogueOrder.js';
export {
  STRUCTURE_KINDS,
  STRUCTURE_KIND_CATALOGUE_VERSION,
  DEFAULT_STRUCTURE_KIND,
  UNBUILDABLE_STRUCTURE_KINDS,
  isBuildableStructureKind,
  getStructureKind,
  isStructureKindId,
  structureKindToIndex,
  structureKindFromIndex,
} from './structureKinds/lookup.js';
export { STRUCTURE_SIDES } from './structureKinds/sides.js';
export {
  structureHullPoints,
  STRUCTURE_ROTATIONS,
  normaliseStructureRotation,
  structureHalfExtents,
} from './structureKinds/geometry.js';
export type { StructureRotation } from './structureKinds/geometry.js';
