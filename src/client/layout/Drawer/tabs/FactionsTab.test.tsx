import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FactionsTab } from './FactionsTab';
import { useUIStore } from '../../../state/store';

const PLAYER = '6a7e0000-0000-4000-8000-0000000000a1';
const OTHER = '6a7e0000-0000-4000-8000-0000000000b2';
const VIEW = {
  rows: [
    { factionId: OTHER, name: 'Quinn', kind: 'player', color: 0x9aa0b4, theirView: -30, yourView: 0 },
    { factionId: 'traders', name: 'Traders', kind: 'guild', color: 0xffd060, theirView: 12.5, yourView: 0 },
    { factionId: 'core', name: 'Sol Dominion', kind: 'power', color: 0x6fb6ff, theirView: 0, yourView: -4 },
  ],
  policy: { hostileBelow: null, alliedAbove: null },
};

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../net/tradeClient', () => ({
  sendSetFactionPolicy: (p: unknown) => { sent.push(p); return true; },
}));
vi.mock('../../../identity/token', () => ({ loadStoredPlayerId: () => PLAYER }));

describe('FactionsTab (v4 F3)', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => VIEW })));
    useUIStore.getState().setDrawerTab('factions');
    useUIStore.getState().setDrawerOpen(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUIStore.getState().setDrawerOpen(false);
  });

  it('shows each faction’s view of you and yours of them, by name (no raw ids)', async () => {
    render(<FactionsTab />);
    await waitFor(() => expect(screen.getAllByTestId('faction-row')).toHaveLength(3));
    expect(fetch).toHaveBeenCalledWith(`/trade/factions?playerId=${PLAYER}`);
    expect(screen.getByText('Quinn')).toBeTruthy();
    expect(screen.getByText('Wary -30')).toBeTruthy();
    expect(screen.getByText('Neutral +12.5')).toBeTruthy();
    expect(document.body.textContent).not.toContain(OTHER);
  });

  it('changing the turret rule sends the player’s policy', async () => {
    render(<FactionsTab />);
    await waitFor(() => expect(screen.getAllByTestId('faction-row')).toHaveLength(3));
    const select = screen.getByTestId('faction-policy-hostile');
    fireEvent.change(select, { target: { value: '-25' } });
    // MUI Select renders a hidden native input; drive it through the button.
    if (sent.length === 0) {
      fireEvent.mouseDown(within(select.parentElement!).getByRole('combobox'));
      fireEvent.click(await screen.findByRole('option', { name: '-25' }));
    }
    expect(sent).toEqual([{ hostileBelow: -25, alliedAbove: null }]);
  });

  it('does not poll while hidden', () => {
    useUIStore.getState().setDrawerOpen(false);
    render(<FactionsTab />);
    expect(fetch).not.toHaveBeenCalled();
  });
});
