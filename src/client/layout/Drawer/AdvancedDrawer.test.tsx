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
vi.mock('./tabs/FactionsTab', () => ({ FactionsTab: () => <div>factions page</div> }));
vi.mock('./tabs/ShipLookTab', () => ({ ShipLookTab: () => <div>look page</div> }));
vi.mock('./tabs/ProfileTab', () => ({ ProfileTab: () => <div>profile page</div> }));
vi.mock('./tabs/SettingsTab', () => ({ SettingsTab: () => <div>settings page</div> }));
vi.mock('./tabs/DebugTab', () => ({ DebugTab: () => <div>debug page</div> }));

const { AdvancedDrawer, pagesOfPanel } = await import('./AdvancedDrawer');

beforeEach(() => { useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' }); });
afterEach(() => { useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' }); });

describe('AdvancedDrawer: each rail panel shows only its own pages', () => {
  it('maps pages to panels as the plan says', () => {
    expect(pagesOfPanel('galaxy').map((p) => p.id)).toEqual(['galaxy']);
    expect(pagesOfPanel('trade')).toEqual([]); // its own drill-down, panels/TradePanel.tsx
    expect(pagesOfPanel('jobs').map((p) => p.id)).toEqual(['contracts']);
    expect(pagesOfPanel('faction').map((p) => p.id)).toEqual(['factions', 'look']);
    expect(pagesOfPanel('cog').map((p) => p.id)).toEqual(['profile', 'settings', 'debug']);
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

  it('the cog: Profile / Settings / Debug switch only; a pick changes the page', () => {
    render(<AdvancedDrawer />);
    act(() => { useUIStore.getState().setDrawerTab('settings'); });
    for (const id of ['profile', 'settings', 'debug']) expect(screen.getByTestId(`drawer-tab-${id}`)).toBeTruthy();
    expect(screen.queryByTestId('drawer-tab-galaxy')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-tab-debug'));
    expect(useUIStore.getState().drawerTab).toBe('debug');
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(screen.getByTestId('drawer-panel-debug').textContent).toBe('debug page');
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
