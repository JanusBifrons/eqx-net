/**
 * The rail's page panels (UI language plan A4, drawer mapping): Galaxy, Jobs,
 * Faction and the cog (Trade is its own drill-down, panels/TradePanel.tsx). Each rail item opens ONLY its own pages in the one
 * right panel (`EqxPanel`); there is no tab column (owner 2026-11-22: the old
 * drawer's sidebar is redundant next to the rail). A panel with more than one
 * page (Faction: Factions / Ship look; cog: Profile / Settings / Debug) shows a
 * page switch at the top; `drawerTab` is the page shown.
 *
 * **Performance contract** (docs/LESSONS.md 2026-05-13 "Drawer perf paradigm"):
 * `EqxPanel` is a `persistent` MUI Drawer (no Modal, no SwipeableDrawer, no
 * global touch listeners) whose children stay mounted while it is closed, so
 * the current page is pre-mounted and opening it is a CSS flip, not a cold
 * mount. Snapshot-rate subscribers in a page (`tabs/DebugTab.tsx`,
 * `components/ConnectionDiagnostics.tsx`, `components/DevOverlay.tsx`,
 * `components/LogPanel.tsx`) gate on `selectDrawerTabShown('<id>')`
 * (state/rightPanel.ts) so they cost nothing off screen. Static `sx` objects
 * are hoisted (emotion caches by identity).
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { Box } from '@mui/material';
import { EQX_PANEL_SIZE, EqxPanel, EqxSegmented } from '../../../ui/index.js';
import { useUIStore } from '../../state/store';
import { DRAWER_TAB_PANEL, type RailId } from '../../state/rightPanel';
import { ProfileTab } from './tabs/ProfileTab';
import { SettingsTab } from './tabs/SettingsTab';
import { GalaxyTab } from './tabs/GalaxyTab';
import { DebugTab } from './tabs/DebugTab';
import { ContractsTab } from './tabs/ContractsTab';
import { FactionsTab } from './tabs/FactionsTab';
import { ShipLookTab } from './tabs/ShipLookTab';

interface PageSpec {
  id: string;
  label: string;
  node: ReactNode;
}

/** Every page, keyed by its `drawerTab` id. Which panel it belongs to is
 *  `DRAWER_TAB_PANEL` (the one mapping). */
const PAGES: readonly PageSpec[] = [
  { id: 'galaxy', label: 'Galaxy', node: <GalaxyTab /> },
  { id: 'contracts', label: 'Jobs', node: <ContractsTab /> },
  { id: 'factions', label: 'Factions', node: <FactionsTab /> },
  { id: 'look', label: 'Ship look', node: <ShipLookTab /> },
  { id: 'profile', label: 'Profile', node: <ProfileTab /> },
  { id: 'settings', label: 'Settings', node: <SettingsTab /> },
  { id: 'debug', label: 'Debug', node: <DebugTab /> },
];

/** The panel title per rail item. */
const PANEL_TITLE: Readonly<Partial<Record<RailId, string>>> = {
  galaxy: 'Galaxy', jobs: 'Jobs', faction: 'Faction', cog: 'Settings',
};

/** The pages of each panel, in order (from `DRAWER_TAB_PANEL`). */
export function pagesOfPanel(panel: RailId): readonly PageSpec[] {
  return PAGES.filter((p) => DRAWER_TAB_PANEL[p.id] === panel);
}

/** The page switch's options for a panel with more than one page (else none). */
const SWITCH_OPTIONS: Readonly<Partial<Record<RailId, { id: string; label: string }[]>>> = Object.fromEntries(
  (Object.keys(PANEL_TITLE) as RailId[])
    .map((panel) => [panel, pagesOfPanel(panel).map(({ id, label }) => ({ id, label }))] as const)
    .filter(([, opts]) => opts.length > 1),
);

/** The panels this drawer draws (Trade has its own panel). */
const OWN_PANELS: ReadonlySet<string> = new Set(PAGES.map((p) => DRAWER_TAB_PANEL[p.id]!));

const DRAWER_PAPER_ATTRS = { 'data-testid': 'advanced-drawer' } as const;

const PAGE_SX = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } as const;

export function AdvancedDrawer(): JSX.Element {
  const isOpen = useUIStore((s) => s.rightPanel !== null && OWN_PANELS.has(s.rightPanel));
  const drawerTab = useUIStore((s) => s.drawerTab);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);

  // Memoised so the page element keeps its identity across renders (a new
  // identity would remount the page, the cold-mount cost keepMounted removed).
  const active = useMemo(() => PAGES.find((p) => p.id === drawerTab) ?? PAGES[0]!, [drawerTab]);
  const panel = DRAWER_TAB_PANEL[active.id]!;
  const options = SWITCH_OPTIONS[panel];
  const handleClose = useCallback(() => setRightPanel(null), [setRightPanel]);

  return (
    <EqxPanel
      open={isOpen}
      onClose={handleClose}
      // The test id goes on the Paper: the persistent Drawer root is a zero-size
      // docked div (the Paper is fixed), so e2e would never see it visible.
      testId="advanced-drawer-root"
      paperAttrs={DRAWER_PAPER_ATTRS}
      closeTestId="drawer-close"
      title={PANEL_TITLE[panel]}
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      {options !== undefined && (
        <EqxSegmented options={options} value={active.id} onChange={setDrawerTab}
          label={`${PANEL_TITLE[panel]} pages`} data-testid="drawer-tab" />
      )}
      <Box role="tabpanel" data-testid={`drawer-panel-${active.id}`} sx={PAGE_SX}>
        {active.node}
      </Box>
    </EqxPanel>
  );
}
