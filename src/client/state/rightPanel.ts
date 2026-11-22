/** The one right-side panel flag (UI plan U1-2), split out of store.ts /
 *  storeTypes.ts (file caps). Discrete UI state, purity-clean: which panel is
 *  open, never a position or size. */

/** The right rail's item ids (plan A3), plus the cog pinned at the bottom. */
export type RailId = 'contacts' | 'hold' | 'fleet' | 'build' | 'galaxy' | 'jobs' | 'trade' | 'faction' | 'cog';

/** Which right-side panel is open; `null` = none. */
export type RightPanel = RailId | 'orders' | 'details' | null;

/** The panel each page (`drawerTab`) belongs to: today's drawer tabs, and the
 *  Trade panel's drill-down (`trade` = its top list, `trade-<section>` a sub-page;
 *  panels/TradePanel.tsx). */
export const DRAWER_TAB_PANEL: Readonly<Record<string, RailId>> = {
  galaxy: 'galaxy',
  trade: 'trade',
  'trade-offers': 'trade',
  'trade-deals': 'trade',
  'trade-history': 'trade',
  'trade-blueprints': 'trade',
  contracts: 'jobs',
  bounties: 'jobs',
  factions: 'faction',
  look: 'faction',
  profile: 'cog',
  settings: 'cog',
  debug: 'cog',
};

const DRAWER_PANELS: ReadonlySet<RightPanel> = new Set(Object.values(DRAWER_TAB_PANEL));

/** The panel a drawer tab lives in. An unknown tab falls back to Galaxy, the
 *  drawer's first tab (the drawer shows that tab for an unknown id too). */
export function panelForDrawerTab(tab: string): RailId {
  return DRAWER_TAB_PANEL[tab] ?? 'galaxy';
}

/** The store slice: the flag plus the page inside the open panel. */
export interface RightPanelUi {
  /** Which right-side panel is open (`null` = none). Discrete UI flag. */
  rightPanel: RightPanel;
  /** The page inside the open panel: the drawer's sub-tab today (`galaxy` |
   *  `trade` | `contracts` | `factions` | `look` | `profile` | `settings` |
   *  `debug`), or a drill-down page (`trade` top list, `trade-<section>`). */
  drawerTab: string;
  setRightPanel: (panel: RightPanel) => void;
  /** Shows `tab` and opens the panel it belongs to. */
  setDrawerTab: (tab: string) => void;
}

/** The slice's initial state and setters, spread into the store. */
export function rightPanelSlice(set: (partial: Partial<RightPanelUi>) => void): RightPanelUi {
  return {
    rightPanel: null,
    drawerTab: 'galaxy',
    setRightPanel: (panel) => set({ rightPanel: panel }),
    setDrawerTab: (tab) => set({ drawerTab: tab, rightPanel: panelForDrawerTab(tab) }),
  };
}

type PanelState = Pick<RightPanelUi, 'rightPanel' | 'drawerTab'>;

/** True while the (old) advanced drawer shows: a drawer group's panel is open. */
export const selectDrawerOpen = (s: Pick<RightPanelUi, 'rightPanel'>): boolean => DRAWER_PANELS.has(s.rightPanel);

/** True while any panel docks over the right edge (`rightPanel`, the one flag:
 *  a rail panel, Orders or Details, where a building's settings live). The HUD
 *  hides what sits under that glass (weapon strip, right-thumb lock stick and BOOST). */
export const selectRightPanelOpen = (s: Pick<RightPanelUi, 'rightPanel'>): boolean => s.rightPanel !== null;

/** True while drawer tab `tab` is on screen (the snapshot-rate gate). */
export const selectDrawerTabShown = (tab: string) => (s: PanelState): boolean =>
  s.drawerTab === tab && selectDrawerOpen(s);

/** Opens the drawer on its current tab (the old `setDrawerOpen(true)`). */
export function openDrawerPanel(s: PanelState & Pick<RightPanelUi, 'setRightPanel'>): void {
  s.setRightPanel(panelForDrawerTab(s.drawerTab));
}

/** Leaving Build closes the Build panel (UI plan U2-1): the patch for a store
 *  write that ends Build. Any other open panel stays. */
export function closeBuildPanel(s: Pick<RightPanelUi, 'rightPanel'>): Partial<RightPanelUi> {
  return s.rightPanel === 'build' ? { rightPanel: null } : {};
}
