import type { ReactNode } from 'react';
import HubIcon from '@mui/icons-material/Hub';
import BoltIcon from '@mui/icons-material/Bolt';
import SecurityIcon from '@mui/icons-material/Security';
import FactoryIcon from '@mui/icons-material/Factory';
import ApartmentIcon from '@mui/icons-material/Apartment';
import TripOriginIcon from '@mui/icons-material/TripOrigin';
import CrisisAlertIcon from '@mui/icons-material/CrisisAlert';
import { COASTAL_DEFENCE_KINDS, type StructureKindId } from '@shared-types/structureKinds';

/**
 * Build menu categories (WS-13 / R2.6): the Build sidebar's rail.
 *
 * The Build menu groups the 9 placeable structure kinds into three player-facing
 * categories (the sidebar's rail) instead of dumping a flat
 * 9-icon list. This taxonomy is **client-only presentation** — it is NOT a field
 * on the wire catalogue (`structureKinds.ts`), so it needs no
 * `STRUCTURE_KIND_CATALOGUE_VERSION` bump and never rides a snapshot (no netgate).
 *
 * Grouping by FUNCTION:
 *   - Core    — the grid backbone (capital hub + connector relay)
 *   - Economy — power + resources (solar generates, battery stores, miner extracts)
 *   - Defence — the combat structures (turrets + shield pylon)
 *
 * The union of every category's `kinds` must equal `STRUCTURE_KINDS_LIST` exactly
 * (no orphan, no duplicate) — locked by `buildCategories.test.ts`, which fails
 * closed the moment a 10th kind is appended to the catalogue without a category.
 */
export type BuildCategoryId = 'core' | 'economy' | 'industry' | 'defence' | 'batteries' | 'habitation' | 'transport';

export interface BuildCategory {
  readonly id: BuildCategoryId;
  readonly label: string;
  readonly icon: ReactNode;
  readonly kinds: readonly StructureKindId[];
}

export const BUILD_CATEGORIES: readonly BuildCategory[] = [
  { id: 'core', label: 'Core', icon: <HubIcon />, kinds: ['capital', 'connector', 'territory_lock'] },
  {
    id: 'economy',
    label: 'Economy',
    icon: <BoltIcon />,
    kinds: ['solar', 'battery', 'miner', 'gas_collector', 'deep_core_rig', 'cargo_bay', 'freight_dock', 'reactor', 'battery_bank', 'storage_vault'],
  },
  // Production chains (plan soft-leaping-truffle v3, P2a): the processors.
  {
    id: 'industry',
    label: 'Industry',
    icon: <FactoryIcon />,
    kinds: [
      'reclaimer',
      'smelter',
      'refinery',
      'silicon_works',
      'hydroponics',
      'fabricator',
      'munitions_works',
      'ore_processing_complex',
      'assembly_plant',
      'research_lab',
      'shipyard',
    ],
  },
  {
    id: 'defence',
    label: 'Defence',
    icon: <SecurityIcon />,
    kinds: ['turret', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret', 'mine_layer', 'shield_pylon', 'shield_gate', 'shield_airlock'],
  },
  // Coastal defences: the naval gun catalogue, light AA up to the siege gun.
  { id: 'batteries', label: 'Gun Batteries', icon: <CrisisAlertIcon />, kinds: COASTAL_DEFENCE_KINDS },
  // D3 — habitation: station residents use provisions and consumer goods and pay taxes.
  { id: 'habitation', label: 'Habitation', icon: <ApartmentIcon />, kinds: ['habitat_module', 'tower_module'] },
  // v4 T1 — teleporters: paired pads that swap ships and cargo.
  { id: 'transport', label: 'Transport', icon: <TripOriginIcon />, kinds: ['teleporter', 'teleporter_large'] },
];

/** Each category's icon on the Build sidebar's rail (BuildSidebar.tsx). */
export const CATEGORY_ICON: Record<BuildCategoryId, ReactNode> = {
  core: <HubIcon />,
  economy: <BoltIcon />,
  industry: <FactoryIcon />,
  defence: <SecurityIcon />,
  batteries: <CrisisAlertIcon />,
  habitation: <ApartmentIcon />,
  transport: <TripOriginIcon />,
};

/** Resolve a category record by id (every id is present — exhaustiveness-locked). */
export function categoryById(id: BuildCategoryId): BuildCategory {
  const cat = BUILD_CATEGORIES.find((c) => c.id === id);
  // Unreachable: BUILD_CATEGORIES covers every BuildCategoryId.
  if (cat === undefined) throw new Error(`unknown build category: ${id}`);
  return cat;
}
