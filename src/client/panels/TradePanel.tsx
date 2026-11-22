/**
 * The Trade right panel (UI language plan A4, job U2-6a): a drill-down. The top
 * page shows your credits, standing and the base you trade from, then one
 * `EqxListRow` per section (Offers, Deals, History, Gift, Blueprints); a row
 * opens that section's page and the header gets ← back.
 *
 * The page shown is the store's `drawerTab` (the page inside the open panel):
 * `trade` = the top list, `trade-<section>` = a sub-page; `DRAWER_TAB_PANEL`
 * maps all of them to the `trade` panel, so a rail tap keeps the page you left.
 * Data comes from `useTradeData` (polls only while this panel is open). Gift
 * and Blueprints keep their old bodies for now (U2-6b moves them in here).
 */
import { useCallback } from 'react';
import { EQX_PANEL_SIZE, EqxListRow, EqxPanel, EqxSection } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import {
  activeDealCount, TradeDealsPage, TradeHeader, TradeHistoryPage, TradeOffersPage, TradeSignIn, useTradeData,
  type TradeData,
} from '../layout/Drawer/tabs/TradeTab';
import { BlueprintMarketSection } from '../layout/Drawer/tabs/BlueprintMarketSection';
import { TradeGiftPage } from './TradeGiftPage';

/** The top list's page id (`drawerTab`). */
export const TRADE_TOP = 'trade';

type TradeSection = 'offers' | 'deals' | 'history' | 'gift' | 'blueprints';

/** The sections, in order: label and the `drawerTab` page id. */
export const TRADE_SECTIONS: readonly { id: TradeSection; label: string }[] = [
  { id: 'offers', label: 'Offers' },
  { id: 'deals', label: 'Deals' },
  { id: 'history', label: 'History' },
  { id: 'gift', label: 'Gift' },
  { id: 'blueprints', label: 'Blueprints' },
];

const pageOf = (id: TradeSection): string => `trade-${id}`;
const PAPER_ATTRS = { 'data-testid': 'trade-panel' } as const;

function sectionSide(id: TradeSection, data: TradeData): string | undefined {
  if (id === 'offers') return data.offers.length > 0 ? String(data.offers.length) : undefined;
  if (id === 'deals') {
    const n = activeDealCount(data.view);
    return n !== null && n > 0 ? String(n) : undefined;
  }
  return undefined;
}

function SectionPage({ id, data, shown }: { id: TradeSection; data: TradeData; shown: boolean }): JSX.Element {
  switch (id) {
    case 'offers': return <TradeOffersPage offers={data.offers} baseId={data.baseId} />;
    case 'deals': return <TradeDealsPage view={data.view} />;
    case 'history': return <TradeHistoryPage view={data.view} shown={shown} />;
    case 'gift': return <TradeGiftPage baseId={data.baseId} />;
    case 'blueprints': return <BlueprintMarketSection baseId={data.baseId} />;
  }
}

export function TradePanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'trade');
  const page = useUIStore((s) => s.drawerTab);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);
  const data = useTradeData(open);
  const section = TRADE_SECTIONS.find((s) => pageOf(s.id) === page);
  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);
  const onBack = useCallback(() => setDrawerTab(TRADE_TOP), [setDrawerTab]);

  let body: JSX.Element;
  if (!data.signedIn) body = <TradeSignIn />;
  else if (section !== undefined) body = <SectionPage id={section.id} data={data} shown={open} />;
  else {
    body = (
      <>
        <EqxSection title="Standing" data-testid="trade-standing">
          <TradeHeader data={data} />
        </EqxSection>
        {TRADE_SECTIONS.map((s) => (
          <EqxListRow key={s.id} primary={s.label} side={sectionSide(s.id, data)}
            onOpen={() => setDrawerTab(pageOf(s.id))} data-testid={`trade-section-${s.id}`} />
        ))}
      </>
    );
  }

  return (
    <EqxPanel
      open={open}
      onClose={onClose}
      // The test id goes on the Paper: the persistent Drawer root is a zero-size
      // docked div (the Paper is fixed), so e2e would never see it visible.
      testId="trade-panel-root"
      paperAttrs={PAPER_ATTRS}
      closeTestId="trade-panel-close"
      title={section?.label ?? 'Trade'}
      onBack={section !== undefined && data.signedIn ? onBack : undefined}
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      {body}
    </EqxPanel>
  );
}
