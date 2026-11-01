import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { CargoPanel } from './CargoPanel';
import { useUIStore } from '../state/store';
import type { CargoState } from '../../shared-types/messages/cargoMessages';

const state = (over: Partial<CargoState> = {}): CargoState => ({
  type: 'cargo_state', entityId: 9, open: true,
  hold: { goods: { alloy: 20 }, blueprints: [] }, used: 40, capacity: 5000,
  ship: { goods: { salvage: 3 }, blueprints: [] }, shipCapacity: 300, ...over,
});

describe('CargoPanel (C1)', () => {
  afterEach(() => {
    send.mockReset();
    act(() => useUIStore.getState().setCargoState(null));
  });

  it('asks on mount, then shows both panes by name', () => {
    render(<CargoPanel entityId={9} />);
    expect(send).toHaveBeenCalledWith('cargo_query', { type: 'cargo_query', entityId: 9 });
    act(() => useUIStore.getState().setCargoState(state()));
    const here = screen.getAllByTestId('cargo-here-row');
    const aboard = screen.getAllByTestId('cargo-aboard-row');
    expect(here[0]!.textContent).toContain('Alloy ×20');
    expect(aboard[0]!.textContent).toContain('Salvage ×3');
    expect(screen.getByTestId('cargo-panel').getAttribute('data-open')).toBe('1');
  });

  it('Take all / Put 1 send the matching cargo_move', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state()));
    fireEvent.click(screen.getByTestId('cargo-here-row').querySelector('[data-testid="cargo-take-all"]')!);
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { alloy: 20 } } });
    fireEvent.click(screen.getByTestId('cargo-aboard-row').querySelector('[data-testid="cargo-put-one"]')!);
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'put', items: { goods: { salvage: 1 } } });
  });

  it('shows why it is locked, and holds a move verdict', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ open: false, hold: null, ship: null, message: 'Locked. That cargo is not yours.' })));
    expect(screen.getByTestId('cargo-locked').textContent).toContain('Locked');
    expect(screen.queryByTestId('cargo-here-row')).toBeNull();
    act(() => useUIStore.getState().setCargoState(state({ ok: false, message: 'No room aboard for that.' })));
    expect(screen.getByTestId('cargo-notice').textContent).toBe('No room aboard for that.');
  });

  it('ignores a reply for a different structure', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ entityId: 10 })));
    expect(screen.queryByTestId('cargo-here-row')).toBeNull();
  });
});
