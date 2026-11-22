/**
 * UI plan U2-6a: Trade is a drill-down. The top page lists the sections; a row
 * opens its page (`drawerTab = trade-<section>`) and the header gets ← back;
 * back returns to the list; ✕ closes the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import type { TradeData } from '../layout/Drawer/tabs/TradeTab';

const data: { current: TradeData } = {
  current: { signedIn: true, wallet: 0, view: null, offers: [], storages: [], baseId: null, setBaseId: () => {} },
};

vi.mock('../layout/Drawer/tabs/TradeTab', () => ({
  useTradeData: () => data.current,
  activeDealCount: () => 2,
  TradeSignIn: () => <div data-testid="trade-signin">sign in</div>,
  TradeHeader: () => <div data-testid="trade-header">header</div>,
  TradeOffersPage: () => <div data-testid="trade-offers">offers</div>,
  TradeDealsPage: () => <div data-testid="trade-deals">deals</div>,
  TradeHistoryPage: () => <div data-testid="trade-history">history</div>,
}));
vi.mock('./TradeGiftPage', () => ({
  TradeGiftPage: () => <div data-testid="trade-gift">gift</div>,
}));
vi.mock('../layout/Drawer/tabs/BlueprintMarketSection', () => ({
  BlueprintMarketSection: () => <div data-testid="trade-blueprints">blueprints</div>,
}));

import { TradePanel, TRADE_SECTIONS } from './TradePanel';

beforeEach(() => {
  data.current = { ...data.current, signedIn: true };
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});

describe('TradePanel (U2-6a drill-down)', () => {
  it('the top list: header, one row per section, no ← back', () => {
    render(<TradePanel />);
    act(() => useUIStore.getState().setDrawerTab('trade'));
    expect(screen.getByTestId('trade-panel')).toBeVisible();
    expect(screen.getByTestId('trade-header')).toBeTruthy();
    expect(TRADE_SECTIONS.map((s) => s.label)).toEqual(['Offers', 'Deals', 'History', 'Gift', 'Blueprints']);
    for (const s of TRADE_SECTIONS) expect(screen.getByRole('button', { name: s.label })).toBeTruthy();
    expect(screen.getByTestId('trade-section-deals')).toHaveTextContent('2');
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
  });

  it('a row opens its page with ← back and the section title; back returns to the list', () => {
    render(<TradePanel />);
    act(() => useUIStore.getState().setDrawerTab('trade'));
    fireEvent.click(screen.getByTestId('trade-section-offers'));
    expect(useUIStore.getState().drawerTab).toBe('trade-offers');
    expect(useUIStore.getState().rightPanel).toBe('trade');
    expect(screen.getByTestId('trade-offers')).toBeTruthy();
    expect(screen.queryByTestId('trade-section-offers')).toBeNull();
    expect(screen.getByTestId('trade-panel')).toHaveTextContent('Offers');

    fireEvent.click(screen.getByTestId('eqx-panel-back'));
    expect(useUIStore.getState().drawerTab).toBe('trade');
    expect(screen.getByTestId('trade-section-offers')).toBeTruthy();
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
  });

  it('each row opens its own page', () => {
    render(<TradePanel />);
    for (const s of TRADE_SECTIONS) {
      act(() => useUIStore.getState().setDrawerTab('trade'));
      fireEvent.click(screen.getByTestId(`trade-section-${s.id}`));
      expect(screen.getByTestId(`trade-${s.id}`)).toBeTruthy();
    }
  });

  it('✕ closes the panel from a sub-page', () => {
    render(<TradePanel />);
    act(() => useUIStore.getState().setDrawerTab('trade-deals'));
    expect(screen.getByTestId('trade-deals')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trade-panel-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('closed while another panel is open', () => {
    render(<TradePanel />);
    act(() => useUIStore.getState().setDrawerTab('galaxy'));
    expect(screen.getByTestId('trade-panel')).not.toBeVisible();
  });

  it('signed out: the sign-in line, no rows, no ← back', () => {
    data.current = { ...data.current, signedIn: false };
    render(<TradePanel />);
    act(() => useUIStore.getState().setDrawerTab('trade-offers'));
    expect(screen.getByTestId('trade-signin')).toBeTruthy();
    expect(screen.queryByTestId('trade-section-offers')).toBeNull();
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
  });
});
