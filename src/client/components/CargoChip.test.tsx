import { describe, expect, it, beforeEach, vi } from 'vitest';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { render, screen, fireEvent, act } from '@testing-library/react';
import { CargoChip } from './CargoChip';
import { useUIStore } from '../state/store';

function reset(): void {
  act(() => {
    useUIStore.setState({ cargo: null, cargoCapacity: 0, lootFeed: [], cargoState: null, playerId: 'me' });
  });
}

describe('CargoChip (P1a-1)', () => {
  beforeEach(reset);

  it('renders nothing while carrying nothing', () => {
    render(<CargoChip />);
    expect(screen.queryByTestId('cargo-chip')).toBeNull();
  });

  it('shows weight / capacity (credits live in the wallet) and turns red when full', () => {
    act(() => {
      useUIStore.getState().setCargo({ goods: { salvage: 300 }, blueprints: 1 }, 300);
    });
    render(<CargoChip />);
    const chip = screen.getByTestId('cargo-chip');
    expect(chip.getAttribute('data-cargo-weight')).toBe('300');
    expect(chip.getAttribute('data-cargo-fill')).toBe('full');
    expect(chip.textContent).toContain('★1');
  });

  it('tap opens "your hold": the loot window on your own ship, everything visible (slice 19)', () => {
    act(() => {
      useUIStore.getState().setCargo({ goods: { alloy: 2 }, blueprints: 0 }, 300);
    });
    render(<CargoChip />);
    fireEvent.click(screen.getByTestId('cargo-chip'));
    expect(send).toHaveBeenCalledWith('cargo_query', expect.objectContaining({ ship: 'me' }));
    act(() => useUIStore.getState().setCargoState({
      type: 'cargo_state', targetShip: 'me', open: true, own: true, takeable: false,
      hold: { goods: { alloy: 2 }, blueprints: [] }, used: 2, capacity: 300, ship: null, shipCapacity: 0, autoUnload: true,
    }));
    const win = screen.getByTestId('loot-window');
    expect(win.textContent).toContain('Your ship');
    expect(win.textContent).toContain('Own');
    expect(screen.getAllByTestId('cargo-here-row').map((r) => r.getAttribute('data-key'))).toEqual(['g:alloy']);
    expect(screen.queryByTestId('cargo-aboard-grid'), 'one hold, not two').toBeNull();
    fireEvent.click(screen.getAllByTestId('cargo-here-row')[0]!);
    expect(screen.getByTestId('cargo-selected').textContent).toContain('Alloy ×2');
    expect(send).not.toHaveBeenCalledWith('cargo_move', expect.anything());
  });

  it('shows pickup popups', () => {
    act(() => {
      useUIStore.getState().pushLootFeed('+7 Salvage');
    });
    render(<CargoChip />);
    expect(screen.getByTestId('loot-feed-line').textContent).toBe('+7 Salvage');
  });
});
