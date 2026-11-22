/**
 * The right rail and its one panel (UI language plan A3/A4, job U1-5).
 *
 * - Draws EqxRail in `<Slot anchor="right-rail">` with the current mode's items
 *   (`railItems.ts`, from `selectControlMode`).
 * - Sets `--rail-w` on `<html>` to the rail's width while it shows (0px when
 *   hidden), so the right-edge HUD, the panels docked left of the rail and the
 *   camera focus insets (`railWidthPx`) all make room for it.
 * - Driven by the store's `rightPanel` flag: a rail pick sets it, a second pick
 *   of the open item, ✕ or Esc clears it. Renders the panels the flag opens:
 *   Galaxy (`panels/GalaxyPanel.tsx`), the Trade drill-down (`panels/TradePanel.tsx`),
 *   Jobs (`panels/JobsPanel.tsx`), Faction (`panels/FactionPanel.tsx`), Contacts
 *   (`panels/ContactsPanel.tsx`; the O key too), the cog
 *   panel (`panels/CogPanel.tsx`) and the
 *   selection's Details panel (opened from the left strip's ⚙, not a rail item).
 *   The Build panel (`build`) is mounted by GameHud (BuildSidebarHost) and opens
 *   on the same flag.
 */
import { useEffect, useMemo } from 'react';
import { EqxIcon, EqxRail, railWidthFor, useRailCompact, type EqxRailItem } from '../../ui/index.js';
import { selectControlMode, useShouldRenderHud, useUIStore } from '../state/store';
import { panelForDrawerTab } from '../state/rightPanel';
import type { UIStore } from '../state/storeTypes';
import { HoldPanel } from '../panels/HoldPanel';
import { TradePanel } from '../panels/TradePanel';
import { JobsPanel } from '../panels/JobsPanel';
import { GalaxyPanel } from '../panels/GalaxyPanel';
import { FleetRailPanel } from '../panels/FleetPanel';
import { DetailsPanel } from '../panels/DetailsPanel';
import { CogPanel } from '../panels/CogPanel';
import { FactionPanel } from '../panels/FactionPanel';
import { ContactsPanel, type ContactsPanelProps } from '../panels/ContactsPanel';
import { Slot } from './Slot';
import { RAIL_COG, railItemById, railTools, RAIL_COMMON, type RailItemSpec } from './railItems';

type PickState = Pick<UIStore, 'rightPanel' | 'drawerTab' | 'setRightPanel' | 'setDrawerTab'>;

/** What a rail tap does (pure over the store slice; unit-tested). */
export function pickRailItem(id: string, s: PickState): void {
  const spec = railItemById(id);
  if (spec === undefined) return;
  const open = spec.open;
  if (s.rightPanel === spec.id) { s.setRightPanel(null); return; }
  // A drawer page: keep the page already shown in that panel, else its first page.
  if (open.kind === 'drawer' && panelForDrawerTab(s.drawerTab) !== spec.id) { s.setDrawerTab(open.page); return; }
  s.setRightPanel(spec.id);
}

const toRail = (it: RailItemSpec): EqxRailItem => ({ id: it.id, icon: <EqxIcon name={it.icon} />, tooltip: it.tooltip });
const COMMON = RAIL_COMMON.map(toRail);
const COG = { icon: <EqxIcon name={RAIL_COG.icon} />, tooltip: RAIL_COG.tooltip, id: RAIL_COG.id };

/** Sets `--rail-w` to `px` while mounted (0px after). */
function useRailWidthVar(px: number): void {
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--rail-w', `${px}px`);
    return () => root.setProperty('--rail-w', '0px');
  }, [px]);
}

export function RightPanelHost({ rendererRef }: Pick<ContactsPanelProps, 'rendererRef'> = {}): JSX.Element {
  const shown = useShouldRenderHud();
  const mode = useUIStore(selectControlMode);
  const rightPanel = useUIStore((s) => s.rightPanel);
  // The Trade item carries the unread-offers badge (it moved off the old drawer column).
  const tradeUnread = useUIStore((s) => s.tradeUnread);
  const items = useMemo(() => COMMON.map((it) => (it.id === 'trade' ? { ...it, badge: tradeUnread } : it)), [tradeUnread]);
  const compact = useRailCompact();
  useRailWidthVar(shown ? railWidthFor(compact) : 0);
  const tools = railTools(mode).map(toRail);
  const activeId = rightPanel ?? undefined;
  return (
    <>
      {shown && (
        <Slot anchor="right-rail">
          <EqxRail tools={tools} items={items} cog={COG} activeId={activeId} compact={compact}
            onPick={(id) => pickRailItem(id, useUIStore.getState())} data-testid="right-rail" />
        </Slot>
      )}
      <GalaxyPanel />
      <TradePanel />
      <JobsPanel />
      <HoldPanel />
      <FleetRailPanel />
      <DetailsPanel />
      <CogPanel />
      <FactionPanel />
      <ContactsPanel rendererRef={rendererRef} />
    </>
  );
}
