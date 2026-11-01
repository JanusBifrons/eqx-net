import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { BountyAction } from './BountyAction';
import { useUIStore } from '../state/store';

describe('BountyAction (P4c-2, economy v2 — paid from the wallet)', () => {
  afterEach(() => {
    send.mockReset();
    useUIStore.setState({ tradeToasts: [], wallet: null });
  });

  it('opens the price chips and sends place_bounty (no storage needed)', () => {
    useUIStore.getState().setWallet(1000);
    render(<BountyAction targetPlayerId="them" />);
    expect(screen.queryAllByTestId('bounty-preset')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('ship-action-bounty'));
    const chips = screen.getAllByTestId('bounty-preset');
    expect(chips.map((c) => c.textContent)).toEqual(['100¢', '500¢', '1000¢']);
    fireEvent.click(chips[1]!); // 500 + 25 % fee = 625 ≤ 1000
    expect(send).toHaveBeenCalledWith('place_bounty', { type: 'place_bounty', targetPlayerId: 'them', amount: 500 });
  });

  it('with too few credits it explains instead of sending', () => {
    useUIStore.getState().setWallet(100); // a 100¢ bounty costs 125¢
    render(<BountyAction targetPlayerId="them" />);
    fireEvent.click(screen.getByTestId('ship-action-bounty'));
    fireEvent.click(screen.getAllByTestId('bounty-preset')[0]!);
    expect(send).not.toHaveBeenCalled();
    expect(useUIStore.getState().tradeToasts.at(-1)?.text).toMatch(/125¢/);
  });
});
