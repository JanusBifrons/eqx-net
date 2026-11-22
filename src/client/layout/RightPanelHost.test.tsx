/**
 * UI plan U1-5: the right rail and its panel host. A rail icon sets the
 * `rightPanel` flag and the host shows that panel; ✕ and Esc clear it; the
 * rail's items follow the control mode; the rail stacks above the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../panels/HoldPanel', () => ({ HoldPanel: () => null }));
vi.mock('../components/FleetPanel', () => ({ FleetPanel: () => <div data-testid="fleet-orders" /> }));
vi.mock('../components/FleetStrip', () => ({ FleetStrip: () => null }));

import { useUIStore } from '../state/store';
import { LayoutProvider } from './LayoutProvider';
import { RightPanelHost, pickRailItem } from './RightPanelHost';
import { railItemsFor, railTools } from './railItems';
import { rightPaperSx, EQX_PANEL_SIZE } from '../../ui/EqxPanel/EqxPanel';
import { ANCHOR_STYLES } from './anchors';
import { Z } from './zIndex';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  stubMedia();
  useUIStore.setState({
    rightPanel: null, drawerTab: 'galaxy', contactsOpen: false, travelling: true,
    pilotMode: 'spectator', buildMode: false, placementKind: null, fleetPick: null,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (): void => { render(<LayoutProvider><RightPanelHost /></LayoutProvider>); };

describe('railItems per mode', () => {
  it('Fly: Contacts, Hold, then the common items and the cog', () => {
    expect(railItemsFor('fly').map((i) => i.id)).toEqual(['contacts', 'hold', 'galaxy', 'jobs', 'trade', 'faction', 'cog']);
  });
  it('Command: Fleet first', () => {
    expect(railTools('command').map((i) => i.id)).toEqual(['fleet']);
    expect(railItemsFor('command').map((i) => i.id)).toEqual(['fleet', 'galaxy', 'jobs', 'trade', 'faction', 'cog']);
  });
  it('Build: Build first', () => {
    expect(railItemsFor('build').map((i) => i.id)).toEqual(['build', 'galaxy', 'jobs', 'trade', 'faction', 'cog']);
  });
  it('never more than 8 items plus the cog', () => {
    for (const m of ['fly', 'command', 'build'] as const) expect(railItemsFor(m).length).toBeLessThanOrEqual(9);
  });
});

describe('RightPanelHost', () => {
  it('sets --rail-w to the rail width while mounted', () => {
    mount();
    expect(document.documentElement.style.getPropertyValue('--rail-w')).toBe('48px');
    cleanup();
    expect(document.documentElement.style.getPropertyValue('--rail-w')).toBe('0px');
  });

  it('the Trade item carries the unread-offers badge (moved off the old drawer column)', () => {
    useUIStore.setState({ tradeUnread: 3 });
    mount();
    expect(screen.getByTestId('right-rail-trade').parentElement?.querySelector('.MuiBadge-badge')?.textContent).toBe('3');
    act(() => { useUIStore.setState({ tradeUnread: 0 }); });
    expect(screen.getByTestId('right-rail-trade').parentElement?.querySelector('.MuiBadge-badge')?.className).toContain('MuiBadge-invisible');
  });

  it('rail icon -> flag set -> the host shows that panel; ✕ clears it', () => {
    mount();
    fireEvent.click(screen.getByTestId('right-rail-fleet'));
    expect(useUIStore.getState().rightPanel).toBe('fleet');
    expect(screen.getByTestId('fleet-orders')).toBeTruthy();
    fireEvent.click(screen.getByTestId('rail-panel-fleet-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('Esc clears the flag', () => {
    mount();
    fireEvent.click(screen.getByTestId('right-rail-fleet'));
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('a second tap on the open item closes it', () => {
    mount();
    fireEvent.click(screen.getByTestId('right-rail-fleet'));
    fireEvent.click(screen.getByTestId('right-rail-fleet'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('the rail follows the mode', () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    mount();
    expect(screen.getByTestId('right-rail-contacts')).toBeTruthy();
    expect(screen.getByTestId('right-rail-hold')).toBeTruthy();
    expect(screen.queryByTestId('right-rail-fleet')).toBeNull();
  });
});

describe('pickRailItem', () => {
  const st = () => useUIStore.getState();
  it('a drawer item opens today\'s drawer on its page', () => {
    pickRailItem('jobs', st());
    expect(st().rightPanel).toBe('jobs');
    expect(st().drawerTab).toBe('contracts');
    pickRailItem('cog', st());
    expect(st().rightPanel).toBe('cog');
    expect(st().drawerTab).toBe('settings');
  });
  it('a drawer item keeps a page already in that panel', () => {
    useUIStore.setState({ drawerTab: 'look' });
    pickRailItem('faction', st());
    expect(st().drawerTab).toBe('look');
    expect(st().rightPanel).toBe('faction');
  });
  it('Contacts toggles the contacts list; Build opens and closes the Build panel on the one flag', () => {
    pickRailItem('contacts', st());
    expect(st().contactsOpen).toBe(true);
    pickRailItem('build', st());
    expect(st().rightPanel).toBe('build');
    pickRailItem('build', st());
    expect(st().rightPanel).toBeNull();
    pickRailItem('build', st());
    pickRailItem('galaxy', st()); // another panel replaces it
    expect(st().rightPanel).toBe('galaxy');
  });
});

describe('stacking: the rail is above the panel', () => {
  it('rail z > panel z, so the panel slides under the rail', () => {
    const paper = rightPaperSx(EQX_PANEL_SIZE, true);
    expect(Number(ANCHOR_STYLES['right-rail'].zIndex)).toBeGreaterThan(Number(paper['zIndex']));
    expect(paper['zIndex']).toBe(Z.panel);
    expect(Z.railStrip).toBeGreaterThan(Z.panel);
  });
  it('the panel docks left of the rail', () => {
    expect(rightPaperSx(EQX_PANEL_SIZE, true)['right']).toBe('var(--rail-w, 0px)');
  });
});
