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

  it('T4: an NPC Freight Dock shows a market — Buy/Sell with prices, goods only', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      hold: { goods: { alloy: 20 }, blueprints: [], packed: [{ product: 'structure:smelter', quality: 50 }] },
      market: { buy: { alloy: 12, salvage: 3 }, sell: { alloy: 9, salvage: 2 } },
    })));
    expect(screen.getByTestId('cargo-panel').getAttribute('data-market')).toBe('1');
    const alloy = screen.getAllByTestId('cargo-here-row').find((r) => r.getAttribute('data-key') === 'g:alloy')!;
    expect(alloy.querySelector('[data-testid="cargo-buy-one"]')!.textContent).toBe('Buy 1 · 12¢');
    expect(alloy.querySelector('[data-testid="cargo-buy-all"]')!.textContent).toBe('Buy all · 240¢');
    // A packed item has no price here: no button.
    const packed = screen.getAllByTestId('cargo-here-row').find((r) => r.getAttribute('data-key') === 'p:structure:smelter')!;
    expect(packed.querySelector('[data-testid^="cargo-buy"]')).toBeNull();
    const salvage = screen.getByTestId('cargo-aboard-row');
    fireEvent.click(salvage.querySelector('[data-testid="cargo-sell-all"]')!);
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'put', items: { goods: { salvage: 3 } } });
  });

  it('T4b: your own Freight Dock shows standing orders; add and remove send set_freight_orders', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ orders: [{ good: 'alloy', mode: 'import', level: 200 }] })));
    const row = screen.getByTestId('freight-order');
    expect(row.textContent).toContain('Alloy: buy up to 200');
    fireEvent.change(screen.getByTestId('freight-order-good'), { target: { value: 'fuel' } });
    fireEvent.click(screen.getByTestId('freight-order-mode')); // → sell above
    fireEvent.change(screen.getByTestId('freight-order-level'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('freight-order-add'));
    expect(send).toHaveBeenLastCalledWith('set_freight_orders', {
      type: 'set_freight_orders', entityId: 9,
      orders: [{ good: 'alloy', mode: 'import', level: 200 }, { good: 'fuel', mode: 'export', level: 50 }],
    });
    fireEvent.click(screen.getByTestId('freight-order-remove'));
    expect(send).toHaveBeenLastCalledWith('set_freight_orders', { type: 'set_freight_orders', entityId: 9, orders: [] });
  });

  it('no orders editor on anything but your own Freight Dock', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state()));
    expect(screen.queryByTestId('freight-orders')).toBeNull();
  });

  it('C2: locked cargo offers Break in, then shows progress with Stop', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ open: false, hold: null, ship: null, message: 'Locked. That cargo is not yours.', breakIn: { pct: null, durationMs: 12_000 } })));
    expect(screen.getByTestId('cargo-break-in').textContent).toContain('Break in · 12s');
    fireEvent.click(screen.getByTestId('cargo-break-in'));
    expect(send).toHaveBeenLastCalledWith('break_in', { type: 'break_in', entityId: 9 });
    act(() => useUIStore.getState().setCargoState(state({ open: false, hold: null, ship: null, message: 'Locked.', breakIn: { pct: 0.4, durationMs: 12_000 } })));
    expect(screen.getByTestId('cargo-break-in-progress').getAttribute('data-pct')).toBe('40');
    fireEvent.click(screen.getByTestId('cargo-break-in-cancel'));
    expect(send).toHaveBeenLastCalledWith('break_in_cancel', { type: 'break_in_cancel' });
  });

  it('ignores a reply for a different structure', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ entityId: 10 })));
    expect(screen.queryByTestId('cargo-here-row')).toBeNull();
  });
});
