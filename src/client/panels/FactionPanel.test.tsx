/**
 * UI plan U2-7: the Faction panel. The main page is the Factions page with a
 * Ship look drill-down row (← back returns); each page polls only while shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { selectDrawerTabShown } from '../state/rightPanel';

const PLAYER = '6a7e0000-0000-4000-8000-0000000000a1';
const VIEW = {
  rows: [{ factionId: 'traders', name: 'Traders', kind: 'guild', color: 0xffd060, theirView: 12.5, yourView: 0 }],
  policy: { hostileBelow: null, alliedAbove: null },
};

vi.mock('../net/tradeClient', () => ({ sendSetFactionPolicy: () => true, sendClaimFactionLook: () => true }));
// jsdom has no 2D canvas: the forge-backed pictures are stubbed.
vi.mock('../render/art/shipLookPreview', () => ({ drawShipLook: () => undefined, drawSigilTile: () => undefined }));
vi.mock('../identity/token', () => ({ loadStoredPlayerId: () => PLAYER }));

const { FactionPanel, factionPageFor } = await import('./FactionPanel');

const shown = (tab: string): boolean => selectDrawerTabShown(tab)(useUIStore.getState());

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => VIEW })));
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});

describe('FactionPanel (U2-7)', () => {
  it('the rail item opens the main page: standings plus the Ship look row, no ← back', async () => {
    render(<FactionPanel />);
    act(() => useUIStore.getState().setDrawerTab('factions'));
    expect(useUIStore.getState().rightPanel).toBe('faction');
    expect(screen.getByTestId('faction-panel')).toBeTruthy();
    expect(screen.getByTestId('faction-page-factions')).toBeTruthy();
    expect(screen.getByTestId('factions-tab')).toBeTruthy();
    expect(screen.getByTestId('faction-row-look')).toBeTruthy();
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('faction-row')).toHaveLength(1));
  });

  it('Ship look drills in (← back returns); each page polls only while shown', async () => {
    render(<FactionPanel />);
    act(() => useUIStore.getState().setDrawerTab('factions'));
    fireEvent.click(screen.getByTestId('faction-row-look'));
    expect(useUIStore.getState().drawerTab).toBe('look');
    expect(useUIStore.getState().rightPanel).toBe('faction');
    expect(shown('look')).toBe(true);
    expect(shown('factions')).toBe(false);
    expect(screen.getByTestId('ship-look-tab')).toBeTruthy();
    expect(screen.queryByTestId('factions-tab')).toBeNull();

    fireEvent.click(screen.getByTestId('eqx-panel-back'));
    expect(useUIStore.getState().drawerTab).toBe('factions');
    expect(screen.getByTestId('factions-tab')).toBeTruthy();
    expect(screen.queryByTestId('ship-look-tab')).toBeNull();
  });

  it('closed, it does not poll; ✕ closes it', () => {
    render(<FactionPanel />);
    expect(fetch).not.toHaveBeenCalled();
    act(() => useUIStore.getState().setDrawerTab('factions'));
    fireEvent.click(screen.getByTestId('faction-panel-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(shown('factions')).toBe(false);
  });

  it('factionPageFor: the main page for any non-faction page id', () => {
    expect(factionPageFor('look')).toBe('look');
    expect(factionPageFor('factions')).toBe('factions');
    expect(factionPageFor('galaxy')).toBe('factions');
  });
});
