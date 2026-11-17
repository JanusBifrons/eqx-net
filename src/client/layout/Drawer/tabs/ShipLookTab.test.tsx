import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShipLookTab } from './ShipLookTab';
import { useUIStore } from '../../../state/store';

const PLAYER = '6a7e0000-0000-4000-8000-0000000000a1';
const OTHER = '6a7e0000-0000-4000-8000-0000000000b2';
const VIEW = {
  rows: [
    { factionId: OTHER, name: 'Quinn', kind: 'player', color: 0x9aa0b4, theirView: -30, yourView: 0 },
    { factionId: 'traders', name: 'Traders', kind: 'guild', color: 0xffd060, theirView: 12.5, yourView: 0 },
  ],
  policy: { hostileBelow: null, alliedAbove: null },
};

const claims = vi.hoisted(() => [] as Array<{ colorSlot: number; sigil: number }>);
vi.mock('../../../net/tradeClient', () => ({
  sendClaimFactionLook: (colorSlot: number, sigil: number) => { claims.push({ colorSlot, sigil }); return true; },
}));
// jsdom has no 2D canvas: the forge-backed pictures are stubbed.
vi.mock('../../../render/art/shipLookPreview', () => ({ drawShipLook: () => undefined, drawSigilTile: () => undefined }));
vi.mock('../../../identity/token', () => ({ loadStoredPlayerId: () => PLAYER }));

describe('ShipLookTab (galaxy map 0c)', () => {
  beforeEach(() => {
    claims.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => VIEW })));
    useUIStore.getState().setDrawerTab('look');
    useUIStore.getState().setDrawerOpen(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUIStore.getState().setDrawerOpen(false);
  });

  it('lists free sigils, marks the current look, shows ship and big sigil, and claims a picked one', async () => {
    render(<ShipLookTab />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/trade/factions?playerId=${PLAYER}`));
    expect(screen.getByTestId('faction-look-preview')).toBeTruthy();
    expect(screen.getByTestId('faction-look-sigil-preview')).toBeTruthy();
    expect(screen.getAllByTestId('faction-look-colour')).toHaveLength(12);
    const tiles = screen.getAllByTestId('faction-look-sigil');
    expect(tiles.length).toBeGreaterThan(20);
    expect(tiles.filter((t) => t.getAttribute('data-current') === 'true')).toHaveLength(1);
    const claim = screen.getByTestId('faction-look-claim') as HTMLButtonElement;
    expect(claim.disabled, 'nothing picked yet').toBe(true);
    const other = tiles.find((t) => t.getAttribute('data-current') !== 'true')!;
    fireEvent.click(other);
    expect(claim.disabled).toBe(false);
    fireEvent.click(claim);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sigil).toBe(Number(other.getAttribute('data-sigil')));
  });

  it('does not poll while hidden', () => {
    useUIStore.getState().setDrawerTab('factions');
    render(<ShipLookTab />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('faction-look-picker')).toBeNull();
  });
});
