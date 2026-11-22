/**
 * The Faction panel (UI language plan U2-7), opened by the rail's Faction item
 * (`rightPanel = 'faction'`). The main page is the Factions page (your policy
 * and every faction's standing, `FactionsTab`); a drill-down row opens Ship
 * look (`ShipLookTab` with its `FactionLookPicker`), with ← back. Same pattern
 * as the cog panel (`panels/CogPanel.tsx`).
 *
 * The page shown is the store's `drawerTab` (`factions` = the main page,
 * `look` = Ship look); `DRAWER_TAB_PANEL` maps both to `faction`, so a rail tap
 * keeps the page you left. Each page polls `GET /trade/factions` only while it
 * is on screen (`selectDrawerTabShown`), and only the current page is rendered.
 */
import { useCallback, useMemo, type CSSProperties } from 'react';
import { EQX_PANEL_SIZE, EqxListRow, EqxPanel, EqxSection } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { FactionsTab } from '../layout/Drawer/tabs/FactionsTab';
import { ShipLookTab } from '../layout/Drawer/tabs/ShipLookTab';

/** The Faction panel's pages, keyed by their `drawerTab` id (the main page first). */
export const FACTION_PAGES = ['factions', 'look'] as const;
export type FactionPage = (typeof FACTION_PAGES)[number];

const TITLE: Readonly<Record<FactionPage, string>> = { factions: 'Faction', look: 'Ship look' };

/** The page the panel shows for `drawerTab` (the main page for any other id). */
export function factionPageFor(drawerTab: string): FactionPage {
  return (FACTION_PAGES as readonly string[]).includes(drawerTab) ? (drawerTab as FactionPage) : 'factions';
}

const PAGE_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 16 };
/** The Paper carries the visible test id: a persistent Drawer's root is zero-size. */
const PAPER_ATTRS = { 'data-testid': 'faction-panel' } as const;

function MainPage({ open }: { open: (page: FactionPage) => void }): JSX.Element {
  return (
    <div style={PAGE_STYLE}>
      <EqxSection title="Your ships">
        <EqxListRow primary="Ship look" secondary="The colour and sigil every ship you own wears."
          onOpen={() => open('look')} data-testid="faction-row-look" />
      </EqxSection>
      <FactionsTab />
    </div>
  );
}

export function FactionPanel(): JSX.Element {
  const isOpen = useUIStore((s) => s.rightPanel === 'faction');
  const page = useUIStore((s) => factionPageFor(s.drawerTab));
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);
  const handleClose = useCallback(() => setRightPanel(null), [setRightPanel]);
  const back = useCallback(() => setDrawerTab('factions'), [setDrawerTab]);
  // Memoised so a page keeps its identity across renders (no remount).
  const body = useMemo(
    () => (page === 'look' ? <ShipLookTab /> : <MainPage open={setDrawerTab} />),
    [page, setDrawerTab],
  );

  return (
    <EqxPanel
      open={isOpen}
      onClose={handleClose}
      testId="faction-panel-root"
      paperAttrs={PAPER_ATTRS}
      closeTestId="faction-panel-close"
      title={TITLE[page]}
      onBack={page === 'factions' ? undefined : back}
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div data-testid={`faction-page-${page}`}>{body}</div>
    </EqxPanel>
  );
}
