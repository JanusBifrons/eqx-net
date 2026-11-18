import type { StructureKind } from './types.js';
import { CAPITAL, CARGO_BAY, CONNECTOR, SOLAR, MINER, TURRET, BATTERY, SHIELD_PYLON, LASER_BOLT_TURRET, MISSILE_TURRET, SHIELD_GATE, SHIELD_AIRLOCK } from './grid.js';
import {
  GAS_COLLECTOR, RECLAIMER, SMELTER, REFINERY, SILICON_WORKS, HYDROPONICS, FABRICATOR, MUNITIONS_WORKS,
  FREIGHT_DOCK, DEEP_CORE_RIG, ORE_PROCESSING_COMPLEX, ASSEMBLY_PLANT, RESEARCH_LAB, AUTOCANNON_TURRET,
} from './production.js';
import { REACTOR, BATTERY_BANK, STORAGE_VAULT, SHIPYARD } from './consolidated.js';
import { HABITAT_MODULE, TOWER_MODULE, MINE_LAYER, TELEPORTER, TELEPORTER_LARGE, ALIEN_GATE, POCKET_PAD } from './habitation.js';
import {
  AA_QUAD_40MM, DP_MOUNT_5IN, COASTAL_CASEMATE_8IN, COASTAL_TURRET_11IN, COASTAL_BARBETTE_16IN,
  COASTAL_LINDEMANN, SIEGE_GUN_80CM,
} from './coastal.js';
import { TERRITORY_LOCK } from '../territoryLock.js';

/**
 * Canonical catalogue order = wire subtype-byte index. APPEND-ONLY (invariant
 * #11). The structure subtype rides the shared `shipKind` u8 in the binary
 * swarm wire when the pose-core `kind` byte is 2 — reordering breaks decode for
 * in-flight packets and persisted blueprints.
 */
export const STRUCTURE_KINDS_LIST: readonly StructureKind[] = Object.freeze([
  CAPITAL,
  CONNECTOR,
  SOLAR,
  MINER,
  TURRET,
  BATTERY,
  SHIELD_PYLON,
  // WS-8 (R2.15) — APPENDED at the tail (wire indices 7, 8). Never reorder.
  LASER_BOLT_TURRET,
  MISSILE_TURRET,
  // Living World P1a-2 — APPENDED (wire index 9). Never reorder.
  CARGO_BAY,
  // Gates — APPENDED (wire indices 10, 11). Never reorder.
  SHIELD_GATE,
  SHIELD_AIRLOCK,
  GAS_COLLECTOR,
  RECLAIMER,
  SMELTER,
  REFINERY,
  SILICON_WORKS,
  HYDROPONICS,
  FABRICATOR,
  MUNITIONS_WORKS,
  FREIGHT_DOCK,
  DEEP_CORE_RIG,
  ORE_PROCESSING_COMPLEX,
  ASSEMBLY_PLANT,
  // Economy v2 W3 — APPENDED. Never reorder.
  RESEARCH_LAB,
  AUTOCANNON_TURRET,
  REACTOR,
  BATTERY_BANK,
  STORAGE_VAULT,
  // Economy v2 W5b — APPENDED. Never reorder.
  SHIPYARD,
  // D3 habitation modules — APPENDED. Never reorder.
  HABITAT_MODULE,
  TOWER_MODULE,
  // Mine Layer — APPENDED. Never reorder.
  MINE_LAYER,
  // Teleporters (v4 T1) — APPENDED. Never reorder.
  TELEPORTER,
  TELEPORTER_LARGE,
  // v4 A — APPENDED. Never reorder.
  ALIEN_GATE,
  // Wrap-up W1b — APPENDED. Never reorder.
  POCKET_PAD,
  // Coastal defences — APPENDED. Never reorder.
  AA_QUAD_40MM,
  DP_MOUNT_5IN,
  COASTAL_CASEMATE_8IN,
  COASTAL_TURRET_11IN,
  COASTAL_BARBETTE_16IN,
  COASTAL_LINDEMANN,
  SIEGE_GUN_80CM,
  // Sector control — APPENDED. Never reorder.
  TERRITORY_LOCK,
]);
