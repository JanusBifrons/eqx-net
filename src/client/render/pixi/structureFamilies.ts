/**
 * Structure families (docs/plans/structure-restyle-stage4.md §6): the gameplay
 * grouping each restyle slice works in. Not the catalogue's data files
 * (`grid`, `production`, ...). Every kind belongs to exactly one family; the
 * `Record` over `StructureKindId` makes a new kind fail typecheck until it is
 * given one. A family's style C drawers live in `structureStyleC.<family>.ts`.
 */
import type { StructureKindId } from '../../../shared-types/structureKinds.js';

export const STRUCTURE_FAMILY_IDS = [
  'core', 'power', 'fences', 'lightProduction', 'mining', 'heavyIndustry', 'turrets', 'coastal', 'storage', 'transport',
] as const;

export type StructureFamilyId = (typeof STRUCTURE_FAMILY_IDS)[number];

/** Kind -> family. `core` = capital + connector (Capital tier, parked, §3). */
export const STRUCTURE_FAMILY: Readonly<Record<StructureKindId, StructureFamilyId>> = Object.freeze({
  capital: 'core',
  connector: 'core',
  // 1. Power + solar
  solar: 'power',
  battery: 'power',
  battery_bank: 'power',
  reactor: 'power',
  // 2. Fences + gates (pylons sit here: the walls are built from their positions)
  shield_pylon: 'fences',
  shield_gate: 'fences',
  shield_airlock: 'fences',
  territory_lock: 'fences',
  // 3. Light production
  smelter: 'lightProduction',
  silicon_works: 'lightProduction',
  hydroponics: 'lightProduction',
  fabricator: 'lightProduction',
  munitions_works: 'lightProduction',
  reclaimer: 'lightProduction',
  gas_collector: 'lightProduction',
  research_lab: 'lightProduction',
  refinery: 'lightProduction',
  // 4. Mining
  miner: 'mining',
  deep_core_rig: 'mining',
  // 5. Heavy industry
  ore_processing_complex: 'heavyIndustry',
  assembly_plant: 'heavyIndustry',
  shipyard: 'heavyIndustry',
  // 6. Turrets
  turret: 'turrets',
  laser_bolt_turret: 'turrets',
  missile_turret: 'turrets',
  autocannon_turret: 'turrets',
  mine_layer: 'turrets',
  // 7. Coastal guns
  aa_quad_40mm: 'coastal',
  dp_mount_5in: 'coastal',
  coastal_casemate_8in: 'coastal',
  coastal_turret_11in: 'coastal',
  coastal_barbette_16in: 'coastal',
  coastal_lindemann: 'coastal',
  siege_gun_80cm: 'coastal',
  // 8. Storage + habitation
  storage_vault: 'storage',
  habitat_module: 'storage',
  tower_module: 'storage',
  cargo_bay: 'storage',
  // 9. Transport + docks (large teleporter + alien gate parked: large)
  teleporter: 'transport',
  pocket_pad: 'transport',
  freight_dock: 'transport',
  teleporter_large: 'transport',
  alien_gate: 'transport',
});

/** A kind id's family, or undefined for an unknown id. */
export function structureFamilyOf(kindId: string): StructureFamilyId | undefined {
  return (STRUCTURE_FAMILY as Readonly<Record<string, StructureFamilyId | undefined>>)[kindId];
}
