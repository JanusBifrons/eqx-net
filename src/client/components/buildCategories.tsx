import type { ReactNode } from 'react';
import HubIcon from '@mui/icons-material/Hub';
import BoltIcon from '@mui/icons-material/Bolt';
import SecurityIcon from '@mui/icons-material/Security';
import FactoryIcon from '@mui/icons-material/Factory';
import ApartmentIcon from '@mui/icons-material/Apartment';
import TripOriginIcon from '@mui/icons-material/TripOrigin';
import CrisisAlertIcon from '@mui/icons-material/CrisisAlert';
import HexagonOutlinedIcon from '@mui/icons-material/HexagonOutlined';
import { COASTAL_DEFENCE_KINDS, isDeckOnlyStructureKind, type StructureKindId } from '@shared-types/structureKinds';

/**
 * Build menu categories (WS-13 / R2.6): the Build sidebar's rail.
 *
 * The Build menu groups the placeable structure kinds into player-facing
 * categories (the sidebar's rail; CATEGORY_ICON below is each one's icon) instead
 * of one flat list. This taxonomy is **client-only presentation** — it is NOT a field
 * on the wire catalogue (`structureKinds.ts`), so it needs no
 * `STRUCTURE_KIND_CATALOGUE_VERSION` bump and never rides a snapshot (no netgate).
 *
 * Grouping by FUNCTION: Core (the grid backbone), Economy (power + resources),
 * Industry (processors), Defence, Gun Batteries, Habitation, Transport.
 *
 * The union of every category's `kinds` must equal `STRUCTURE_KINDS_LIST` exactly
 * (no orphan, no duplicate) — locked by `buildCategories.test.ts`, which fails
 * closed the moment a new kind is appended to the catalogue without a category.
 */
export type BuildCategoryId = 'deck' | 'core' | 'economy' | 'industry' | 'defence' | 'batteries' | 'habitation' | 'transport';

export interface BuildCategory {
  readonly id: BuildCategoryId;
  readonly label: string;
  readonly kinds: readonly StructureKindId[];
}

export const BUILD_CATEGORIES: readonly BuildCategory[] = [
  { id: 'core', label: 'Core', kinds: ['capital', 'connector', 'territory_lock'] },
  {
    id: 'economy',
    label: 'Economy',
    kinds: ['solar', 'battery', 'miner', 'gas_collector', 'deep_core_rig', 'cargo_bay', 'freight_dock', 'reactor', 'battery_bank', 'storage_vault'],
  },
  // Production chains (plan soft-leaping-truffle v3, P2a): the processors.
  {
    id: 'industry',
    label: 'Industry',
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
    kinds: ['turret', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret', 'mine_layer', 'shield_pylon', 'shield_gate', 'shield_airlock'],
  },
  // Coastal defences: the naval gun catalogue, light AA up to the siege gun.
  { id: 'batteries', label: 'Gun Batteries', kinds: COASTAL_DEFENCE_KINDS },
  // D3 — habitation: station residents use provisions and consumer goods and pay taxes.
  { id: 'habitation', label: 'Habitation', kinds: ['habitat_module', 'tower_module'] },
  // v4 T1 — teleporters: paired pads that swap ships and cargo. Base
  // platforms: the road deck tile (deck rooms only, `buildableKinds`).
  { id: 'transport', label: 'Transport', kinds: ['teleporter', 'teleporter_large', 'road'] },
];

/**
 * The Deck category (deck rooms only): everything that lives on or shapes the
 * deck in one hexagon tab: the plate-laying Connector (named "Deck plate"
 * there), the shield fences and gates, and the road tile. On a deck room it
 * comes first and its kinds leave their usual categories; elsewhere it is
 * hidden and the taxonomy above is unchanged (so the exhaustiveness lock holds).
 */
export const DECK_CATEGORY: BuildCategory = {
  id: 'deck', label: 'Deck', kinds: ['connector', 'shield_pylon', 'shield_gate', 'shield_airlock', 'road'],
};

/** The categories the Build rail shows in this room (see {@link DECK_CATEGORY}). */
export function categoriesFor(deck: boolean): readonly BuildCategory[] {
  return deck ? DECK_ROOM_CATEGORIES : BUILD_CATEGORIES;
}
const DECK_ROOM_CATEGORIES: readonly BuildCategory[] = [
  DECK_CATEGORY,
  ...BUILD_CATEGORIES
    .map((c) => ({ ...c, kinds: c.kinds.filter((k) => !DECK_CATEGORY.kinds.includes(k)) }))
    .filter((c) => c.kinds.length > 0),
];

/** A kind's name and blurb as the Build menu shows them in this room: on a
 *  deck room the Connector is the "Deck plate" (what it does there). */
export function buildKindText(kindId: StructureKindId, deck: boolean): { name: string; description: string } | null {
  if (deck && kindId === 'connector') {
    return { name: 'Deck plate', description: 'Lays a new deck plate. Place it anywhere clear: in open space it starts a new deck, next to yours it grows it.' };
  }
  return null;
}

/** Each category's icon on the Build sidebar's rail (BuildSidebar.tsx). */
export const CATEGORY_ICON: Record<BuildCategoryId, ReactNode> = {
  deck: <HexagonOutlinedIcon />,
  core: <HubIcon />,
  economy: <BoltIcon />,
  industry: <FactoryIcon />,
  defence: <SecurityIcon />,
  batteries: <CrisisAlertIcon />,
  habitation: <ApartmentIcon />,
  transport: <TripOriginIcon />,
};

/** The kinds a category offers in this room: a deck-only kind (the road tile)
 *  shows only on a deck room (the server refuses it elsewhere too). */
export function buildableKinds(cat: BuildCategory, deck: boolean): readonly StructureKindId[] {
  return deck ? cat.kinds : cat.kinds.filter((k) => !isDeckOnlyStructureKind(k));
}

/** Resolve a category record by id (every id is present — exhaustiveness-locked). */
export function categoryById(id: BuildCategoryId, deck = false): BuildCategory {
  const cat = categoriesFor(deck).find((c) => c.id === id) ?? (id === 'deck' ? DECK_CATEGORY : undefined);
  // Unreachable: BUILD_CATEGORIES + DECK_CATEGORY cover every BuildCategoryId.
  if (cat === undefined) throw new Error(`unknown build category: ${id}`);
  return cat;
}
