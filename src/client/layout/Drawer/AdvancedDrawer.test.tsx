/**
 * Owner 2026-11-22: the old drawer's tab column is redundant next to the rail.
 * Each rail panel shows only its own pages; a panel with several pages gets a
 * page switch, a one-page panel none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../../state/store';

vi.mock('./tabs/GalaxyTab', () => ({ GalaxyTab: () => <div>galaxy page</div> }));
vi.mock('./tabs/ContractsTab', () => ({ ContractsTab: () => <div>jobs page</div> }));

const { AdvancedDrawer, pagesOfPanel } = await import('./AdvancedDrawer');

beforeEach(() => { useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' }); });
afterEach(() => { useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' }); });

describe('AdvancedDrawer: each rail panel shows only its own pages', () => {
  it('maps pages to panels as the plan says', () => {
    expect(pagesOfPanel('galaxy').map((p) => p.id)).toEqual(['galaxy']);
    expect(pagesOfPanel('trade')).toEqual([]); // its own drill-down, panels/TradePanel.tsx
    expect(pagesOfPanel('jobs').map((p) => p.id)).toEqual(['contracts']);
    expect(pagesOfPanel('faction')).toEqual([]); // its own drill-down, panels/FactionPanel.tsx
    // The cog draws its own panel (panels/CogPanel.tsx).
    expect(pagesOfPanel('cog')).toEqual([]);
  });

  it('Galaxy: its page and title, no tab column and no page switch', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('galaxy'); });
    expect(screen.getByTestId('drawer-panel-galaxy').textContent).toBe('galaxy page');
    expect(screen.getByTestId('advanced-drawer')).toBeVisible();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('drawer-tab')).toBeNull();
    expect(screen.queryByTestId('drawer-tab-trade')).toBeNull();
  });

  it('the cog does not open this panel (CogPanel draws it)', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('settings'); });
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(screen.queryByTestId('drawer-tab-settings')).toBeNull();
  });

  it('stays shut while the Faction panel is open (FactionPanel draws it)', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('look'); });
    expect(useUIStore.getState().rightPanel).toBe('faction');
    expect(screen.getByTestId('advanced-drawer')).not.toBeVisible();
  });

  it('✕ closes the panel', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('contracts'); });
    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('stays shut while the Trade panel is open (Trade draws its own panel)', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('trade'); });
    expect(useUIStore.getState().rightPanel).toBe('trade');
    expect(screen.getByTestId('advanced-drawer')).not.toBeVisible();
  });
});
