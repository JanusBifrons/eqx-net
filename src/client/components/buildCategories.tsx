import type { ReactNode } from 'react';
import HubIcon from '@mui/icons-material/Hub';
import BoltIcon from '@mui/icons-material/Bolt';
import SecurityIcon from '@mui/icons-material/Security';
import { type StructureKindId } from '@shared-types/structureKinds';

/**
 * Build speed-dial category tier (WS-13 / R2.6).
 *
 * The Build menu groups the 9 placeable structure kinds into three player-facing
 * categories so the dial drills Build ▸ category ▸ kind instead of dumping a flat
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
export type BuildCategoryId = 'core' | 'economy' | 'defence';

export interface BuildCategory {
  readonly id: BuildCategoryId;
  readonly label: string;
  readonly icon: ReactNode;
  readonly kinds: readonly StructureKindId[];
}

export const BUILD_CATEGORIES: readonly BuildCategory[] = [
  { id: 'core', label: 'Core', icon: <HubIcon />, kinds: ['capital', 'connector'] },
  { id: 'economy', label: 'Economy', icon: <BoltIcon />, kinds: ['solar', 'battery', 'miner'] },
  {
    id: 'defence',
    label: 'Defence',
    icon: <SecurityIcon />,
    kinds: ['turret', 'laser_bolt_turret', 'missile_turret', 'shield_pylon'],
  },
];

/** The drilled-into category's icon (mirrored onto the FAB at the `kinds` level). */
export const CATEGORY_ICON: Record<BuildCategoryId, ReactNode> = {
  core: <HubIcon />,
  economy: <BoltIcon />,
  defence: <SecurityIcon />,
};

/** Resolve a category record by id (every id is present — exhaustiveness-locked). */
export function categoryById(id: BuildCategoryId): BuildCategory {
  const cat = BUILD_CATEGORIES.find((c) => c.id === id);
  // Unreachable: BUILD_CATEGORIES covers every BuildCategoryId.
  if (cat === undefined) throw new Error(`unknown build category: ${id}`);
  return cat;
}

/**
 * The dial's drilled view (pure presentation — LOCAL React state, NEVER Zustand,
 * invariant #2). `root` = the main menu; `categories` = the 3-category tier
 * (after Build ▸); `kinds` = the kind picker for a chosen category.
 */
export type DialView =
  | { level: 'root' }
  | { level: 'categories' }
  | { level: 'kinds'; category: BuildCategoryId };

/** Module-const so the common reset never allocates per render. */
export const ROOT_VIEW: DialView = { level: 'root' };

/**
 * Pure back-navigation reducer: kinds → categories → root; root is a no-op.
 * The FAB stays the open/close toggle; this is what the dedicated back action runs.
 */
export function goBackView(view: DialView): DialView {
  return view.level === 'kinds' ? { level: 'categories' } : ROOT_VIEW;
}
