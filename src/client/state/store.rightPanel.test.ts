import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './store.js';
import {
  DRAWER_TAB_PANEL,
  openDrawerPanel,
  panelForDrawerTab,
  selectDrawerOpen,
  selectDrawerTabShown,
} from './rightPanel.js';

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});

describe('rightPanel flag', () => {
  it('starts closed on the Galaxy page', () => {
    const st = useUIStore.getState();
    expect(st.rightPanel).toBeNull();
    expect(st.drawerTab).toBe('galaxy');
    expect(selectDrawerOpen(st)).toBe(false);
  });

  it('setRightPanel sets and clears the flag', () => {
    useUIStore.getState().setRightPanel('trade');
    expect(useUIStore.getState().rightPanel).toBe('trade');
    expect(selectDrawerOpen(useUIStore.getState())).toBe(true);
    useUIStore.getState().setRightPanel(null);
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(selectDrawerOpen(useUIStore.getState())).toBe(false);
  });

  it('a non-drawer panel (orders, details, contacts) does not show the drawer', () => {
    for (const p of ['orders', 'details', 'contacts', 'hold', 'fleet', 'build'] as const) {
      useUIStore.getState().setRightPanel(p);
      expect(selectDrawerOpen(useUIStore.getState())).toBe(false);
    }
  });
});

describe('drawer tab -> panel mapping', () => {
  it.each([
    ['galaxy', 'galaxy'],
    ['trade', 'trade'],
    ['contracts', 'jobs'],
    ['factions', 'faction'],
    ['look', 'faction'],
    ['profile', 'cog'],
    ['settings', 'cog'],
    ['debug', 'cog'],
  ] as const)('tab %s lives in panel %s', (tab, panel) => {
    expect(DRAWER_TAB_PANEL[tab]).toBe(panel);
    expect(panelForDrawerTab(tab)).toBe(panel);
  });

  it('an unknown tab falls back to Galaxy (the drawer shows its first tab)', () => {
    expect(panelForDrawerTab('nope')).toBe('galaxy');
  });

  it('setDrawerTab shows the page and opens its panel', () => {
    useUIStore.getState().setDrawerTab('look');
    const st = useUIStore.getState();
    expect(st.drawerTab).toBe('look');
    expect(st.rightPanel).toBe('faction');
    expect(selectDrawerTabShown('look')(st)).toBe(true);
    expect(selectDrawerTabShown('factions')(st)).toBe(false);
  });

  it('a tab is not shown while the panel is closed, and the page survives a close', () => {
    useUIStore.getState().setDrawerTab('debug');
    useUIStore.getState().setRightPanel(null);
    const st = useUIStore.getState();
    expect(st.drawerTab).toBe('debug');
    expect(selectDrawerTabShown('debug')(st)).toBe(false);
  });

  it('openDrawerPanel reopens the drawer on its current page', () => {
    useUIStore.getState().setDrawerTab('settings');
    useUIStore.getState().setRightPanel(null);
    openDrawerPanel(useUIStore.getState());
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(useUIStore.getState().drawerTab).toBe('settings');
  });
});
