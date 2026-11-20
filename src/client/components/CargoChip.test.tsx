import { describe, expect, it, beforeEach, vi } from 'vitest';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { render, screen, fireEvent, act } from '@testing-library/react';
import { CargoChip } from './CargoChip';
import { useUIStore } from '../state/store';
import { DEPOSIT_FLOW_STEP, DEPOSIT_WAITING } from '../../shared-types/messages/snapshotMessages';
import { CRANE_CARGO_IN, CRANE_CARGO_OUT } from '../../core/articulation/craneCargo';

function reset(): void {
  act(() => {
    useUIStore.setState({ cargo: null, cargoCapacity: 0, lootFeed: [], depositPct: null, cargoState: null, playerId: 'me' });
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
  it('an empty hold parked to load still shows the crane progress and the waiting row (3e)', () => {
    act(() => {
      useUIStore.setState({ depositPct: 40 });
    });
    const { unmount } = render(<CargoChip />);
    expect(screen.getByTestId('cargo-depositing').getAttribute('data-deposit-pct')).toBe('40');
    unmount();
    act(() => {
      useUIStore.setState({ depositPct: DEPOSIT_WAITING });
    });
    render(<CargoChip />);
    expect(screen.getByTestId('cargo-depositing').getAttribute('data-deposit-waiting')).toBe('1');
  });

  // Hostile review of the Capital crane bay take: during the hold the bar
  // FILLED under an unchanged "226/526", which reads as the hold filling.
  const fillWidth = (): string => screen.getByTestId('cargo-deposit-fill').style.width;

  it('a crane unload says "Unloading" and its bar drains as the hold runs', () => {
    act(() => {
      useUIStore.getState().setCargo({ goods: { salvage: 226 }, blueprints: 0 }, 526);
      useUIStore.setState({ depositPct: CRANE_CARGO_IN * DEPOSIT_FLOW_STEP + 0 });
    });
    const { rerender } = render(<CargoChip />);
    const row = screen.getByTestId('cargo-depositing');
    expect(row.textContent).toBe('Unloading');
    expect(row.getAttribute('data-deposit-pct')).toBe('0');
    expect(fillWidth()).toBe('100%');
    act(() => { useUIStore.setState({ depositPct: CRANE_CARGO_IN * DEPOSIT_FLOW_STEP + 70 }); });
    rerender(<CargoChip />);
    expect(fillWidth()).toBe('30%');
    // The count stays truthful: it changes only when the trade lands.
    expect(screen.getByTestId('cargo-chip').textContent).toContain('226/526');
  });

  it('a crane load says "Loading" and its bar fills', () => {
    act(() => { useUIStore.setState({ depositPct: CRANE_CARGO_OUT * DEPOSIT_FLOW_STEP + 40 }); });
    render(<CargoChip />);
    expect(screen.getByTestId('cargo-depositing').textContent).toBe('Loading');
    expect(fillWidth()).toBe('40%');
  });

  it('the hover deposit dwell keeps its plain filling bar, no label', () => {
    act(() => { useUIStore.setState({ depositPct: 40 }); });
    render(<CargoChip />);
    expect(screen.getByTestId('cargo-depositing').textContent).toBe('');
    expect(fillWidth()).toBe('40%');
  });
});
