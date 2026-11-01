import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
let mirror: unknown = null;
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => (mirror === null ? null : { mirror, getRoom: () => ({ send }) }),
}));

import { BountyAction } from './BountyAction';
import { useUIStore } from '../state/store';

describe('BountyAction (P4c-2)', () => {
  afterEach(() => {
    send.mockReset();
    mirror = null;
    useUIStore.setState({ tradeToasts: [] });
  });

  it('opens the price chips and sends place_bounty from the pilot\'s own storage', () => {
    mirror = {
      localPlayerId: 'me',
      structures: new Map([[7, { owner: 'me', built: true }]]),
      swarm: new Map([[7, { shipKind: 'capital' }]]),
    };
    render(<BountyAction targetPlayerId="them" />);
    expect(screen.queryAllByTestId('bounty-preset')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('ship-action-bounty'));
    const chips = screen.getAllByTestId('bounty-preset');
    expect(chips.map((c) => c.textContent)).toEqual(['100¢', '500¢', '1000¢']);
    fireEvent.click(chips[1]!);
    expect(send).toHaveBeenCalledWith('place_bounty', { type: 'place_bounty', targetPlayerId: 'them', networkEntityId: 7, amount: 500 });
  });

  it('with no own storage here it explains instead of sending', () => {
    mirror = { localPlayerId: 'me', structures: new Map(), swarm: new Map() };
    render(<BountyAction targetPlayerId="them" />);
    fireEvent.click(screen.getByTestId('ship-action-bounty'));
    fireEvent.click(screen.getAllByTestId('bounty-preset')[0]!);
    expect(send).not.toHaveBeenCalled();
    expect(useUIStore.getState().tradeToasts.at(-1)?.text).toMatch(/storage/);
  });
});
