/**
 * The right rail's items per control mode (UI language plan A3, job U1-5).
 * Pure data: the host (`RightPanelHost.tsx`) draws them with EqxRail.
 *
 * Order, top to bottom: the mode's own tools, then the items every mode has.
 * The cog is pinned at the bottom by EqxRail itself (`RAIL_COG`).
 *
 * How each item opens today (wave 1 stubs; each wave-2 job moves one surface
 * into its own `panels/<Id>Panel.tsx`):
 *   - `drawer`: today's advanced drawer on that page (`setDrawerTab(page)` sets
 *     the `rightPanel` flag to the item; AdvancedDrawer shows on that flag).
 *   - `panel`: a `panels/*Panel.tsx` shown while the flag is the item (Build:
 *     panels/BuildPanel.tsx, mounted by GameHud's BuildSidebarHost).
 *
 * Contacts is a common item (every mode: you lock from the list in Fly,
 * Command and Build alike); it is an ordinary `panel` item that opens
 * `panels/ContactsPanel.tsx`. The O key toggles the same flag (`input/MouseLock.ts`).
 */
import type { EqxIconName } from '../../ui/icons.js';
import type { RailId } from '../state/rightPanel.js';
import type { ControlMode } from '../state/storeTypes.js';

export type RailOpen =
  | { kind: 'drawer'; page: string }
  | { kind: 'panel' };

export interface RailItemSpec {
  id: RailId;
  icon: EqxIconName;
  /** Tooltip and aria-label; never visible text. */
  tooltip: string;
  open: RailOpen;
}

const CONTACTS: RailItemSpec = { id: 'contacts', icon: 'contacts', tooltip: 'Contacts', open: { kind: 'panel' } };
const HOLD: RailItemSpec = { id: 'hold', icon: 'hold', tooltip: 'Hold', open: { kind: 'panel' } };
const FLEET: RailItemSpec = { id: 'fleet', icon: 'fleet', tooltip: 'Fleet', open: { kind: 'panel' } };
const BUILD: RailItemSpec = { id: 'build', icon: 'build', tooltip: 'Build', open: { kind: 'panel' } };

/** In every mode, below the mode's tools. */
export const RAIL_COMMON: readonly RailItemSpec[] = [
  CONTACTS,
  { id: 'galaxy', icon: 'galaxy', tooltip: 'Galaxy', open: { kind: 'drawer', page: 'galaxy' } },
  { id: 'jobs', icon: 'jobs', tooltip: 'Jobs', open: { kind: 'drawer', page: 'contracts' } },
  { id: 'trade', icon: 'trade', tooltip: 'Trade', open: { kind: 'drawer', page: 'trade' } },
  { id: 'faction', icon: 'faction', tooltip: 'Faction', open: { kind: 'drawer', page: 'factions' } },
];

/** The pinned cog: today's drawer on its Settings page. */
export const RAIL_COG: RailItemSpec = { id: 'cog', icon: 'cog', tooltip: 'Settings', open: { kind: 'drawer', page: 'settings' } };

const MODE_TOOLS: Readonly<Record<ControlMode, readonly RailItemSpec[]>> = {
  fly: [HOLD],
  command: [FLEET],
  build: [BUILD],
};

/** The current mode's own tools (above the divider). */
export function railTools(mode: ControlMode): readonly RailItemSpec[] {
  return MODE_TOOLS[mode];
}

/** Every item the rail shows in `mode`, top to bottom, cog last. */
export function railItemsFor(mode: ControlMode): readonly RailItemSpec[] {
  return [...MODE_TOOLS[mode], ...RAIL_COMMON, RAIL_COG];
}

/** The spec for a rail id (any mode). */
export function railItemById(id: string): RailItemSpec | undefined {
  if (id === RAIL_COG.id) return RAIL_COG;
  return [HOLD, FLEET, BUILD, ...RAIL_COMMON].find((it) => it.id === id);
}
