import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../../../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { BlueprintMarketSection, listingLine } from './BlueprintMarketSection';
import { useUIStore } from '../../../state/store';
import type { BpListing, BpMarketState } from '../../../../shared-types/blueprintMarket';

const L = (id: string, over: Partial<BpListing> = {}): BpListing => ({
  id, name: 'Gunship', kind: 'bpc', runs: 3, material: 2, output: 20, quality: 30, price: 450, ...over,
});

const state = (over: Partial<BpMarketState> = {}): BpMarketState => ({
  type: 'bp_market_state', networkEntityId: 5, offers: [L('of-1')], mine: [L('bp-mine', { price: 120 })], ...over,
});

describe('BlueprintMarketSection (economy v2 W6)', () => {
  afterEach(() => {
    send.mockReset();
    act(() => useUIStore.getState().setBpMarket(null));
  });

  it('asks on mount; lists the board and my blueprints by name with prices; Buy/Sell send the real messages', () => {
    render(<BlueprintMarketSection baseId={5} />);
    expect(send).toHaveBeenCalledWith('bp_market_query', { type: 'bp_market_query', networkEntityId: 5 });
    act(() => useUIStore.getState().setBpMarket(state()));
    expect(screen.getByTestId('bp-offer').textContent).toContain('Gunship');
    expect(screen.getByTestId('bp-offer-action').textContent).toContain('Buy 450¢');
    expect(screen.getByTestId('bp-mine-action').textContent).toContain('Sell 120¢');
    expect(document.body.textContent).not.toContain('of-1');
    fireEvent.click(screen.getByTestId('bp-offer-action'));
    expect(send).toHaveBeenLastCalledWith('bp_buy', { type: 'bp_buy', networkEntityId: 5, offerId: 'of-1' });
    fireEvent.click(screen.getByTestId('bp-mine-action'));
    expect(send).toHaveBeenLastCalledWith('bp_sell', { type: 'bp_sell', networkEntityId: 5, uid: 'bp-mine' });
  });

  it('shows the verdict, ignores another base’s state, and says when there is no base', () => {
    const { rerender } = render(<BlueprintMarketSection baseId={5} />);
    act(() => useUIStore.getState().setBpMarket(state({ ok: false, message: 'You need 450¢ for that blueprint.' })));
    expect(screen.getByTestId('bp-market-message').textContent).toContain('You need');
    act(() => useUIStore.getState().setBpMarket(state({ networkEntityId: 9 })));
    expect(screen.queryByTestId('bp-market')).toBeNull();
    rerender(<BlueprintMarketSection baseId={null} />);
    expect(document.body.textContent).toContain('Build a Capital or Cargo Bay');
  });

  it('labels originals and copies', () => {
    expect(listingLine(L('x', { kind: 'bpo', runs: null }))).toContain('Original');
    expect(listingLine(L('x', { runs: 1 }))).toContain('Copy · 1 run ');
  });
});
