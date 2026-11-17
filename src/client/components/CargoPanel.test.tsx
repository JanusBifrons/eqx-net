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
    expect(here[0]!.textContent).toContain('Alloy');
    expect(here[0]!.getAttribute('data-count')).toBe('20');
    expect(aboard[0]!.textContent).toContain('Salvage');
    expect(aboard[0]!.getAttribute('data-count')).toBe('3');
    expect(screen.getByTestId('cargo-panel').getAttribute('data-open')).toBe('1');
  });

  it('cargo-pods slice 17: tapping a tile moves the whole stack, either way', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state()));
    fireEvent.click(screen.getByTestId('cargo-here-row'));
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { alloy: 20 } } });
    fireEvent.click(screen.getByTestId('cargo-aboard-row'));
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'put', items: { goods: { salvage: 3 } } });
  });

  it('slice 17: hidden stacks are "?" tiles (the first spins); Take all found takes only what is found', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      hold: { goods: { salvage: 4, alloy: 2 }, blueprints: [] }, hidden: 3, revealInMs: 500,
    })));
    expect(screen.getAllByTestId('cargo-here-row')).toHaveLength(2);
    expect(screen.getAllByTestId('cargo-unknown-tile')).toHaveLength(3);
    expect(screen.getAllByTestId('cargo-search-spinner')).toHaveLength(1);
    expect(screen.getByTestId('cargo-take-found').textContent).toBe('Take all found');
    fireEvent.click(screen.getByTestId('cargo-take-found'));
    expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { salvage: 4, alloy: 2 } } });
  });

  it('slice 17: asks again when the next stack is due, scaled by game speed', () => {
    vi.useFakeTimers();
    try {
      act(() => useUIStore.getState().setTimeScale(2));
      render(<CargoPanel entityId={9} />);
      act(() => useUIStore.getState().setCargoState(state({ hidden: 1, revealInMs: 600 })));
      send.mockClear();
      act(() => { vi.advanceTimersByTime(250); });
      expect(send, 'not before it is due').not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(100); }); // 600 game ms at 2× = 300 ms + 30 slack
      expect(send).toHaveBeenCalledWith('cargo_query', { type: 'cargo_query', entityId: 9 });
    } finally {
      act(() => useUIStore.getState().setTimeScale(1));
      vi.useRealTimers();
    }
  });

  it('slice 17: a weight bar shows your hold against its capacity', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ ship: { goods: { alloy: 10 }, blueprints: [] }, shipCapacity: 80 })));
    const bar = screen.getByTestId('cargo-weight');
    expect(bar.getAttribute('data-used')).toBe('20');
    expect(bar.getAttribute('data-capacity')).toBe('80');
  });

  it('slice 17: your own storage shows both auto-unload switches', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ autoUnload: true, acceptAutoUnload: false })));
    expect(screen.getByTestId('auto-unload-ship').getAttribute('data-on')).toBe('1');
    fireEvent.click(screen.getByTestId('auto-unload-ship'));
    expect(send).toHaveBeenLastCalledWith('set_auto_unload', { type: 'set_auto_unload', side: 'ship', on: false });
    fireEvent.click(screen.getByTestId('auto-unload-storage'));
    expect(send).toHaveBeenLastCalledWith('set_auto_unload', { type: 'set_auto_unload', side: 'storage', on: true, entityId: 9 });
  });

  it('slice 18: dragging a tile onto the other grid moves the stack; a short wiggle is still a tap', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state()));
    const tile = screen.getByTestId('cargo-here-row');
    const aboardGrid = screen.getByTestId('cargo-aboard-grid');
    const spot = vi.fn(() => aboardGrid as Element);
    Object.defineProperty(document, 'elementFromPoint', { value: spot, configurable: true });
    const ptr = (type: string, x: number, y: number): void => { window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y })); };
    try {
      fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 });
      expect(document.querySelector('[data-drag-ghost]'), 'a ghost follows the pointer').not.toBeNull();
      act(() => { ptr('pointermove', 60, 90); ptr('pointerup', 60, 90); });
      expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { alloy: 20 } } });
      expect(document.querySelector('[data-drag-ghost]'), 'the ghost goes on release').toBeNull();
      send.mockClear();
      fireEvent.click(tile); // the click that trails a drag moves nothing more
      expect(send).not.toHaveBeenCalledWith('cargo_move', expect.anything());
      // Dropped back on its own grid: nothing moves.
      spot.mockReturnValue(screen.getByTestId('cargo-here-grid'));
      fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 });
      act(() => { ptr('pointermove', 40, 10); ptr('pointerup', 40, 10); });
      expect(send).not.toHaveBeenCalledWith('cargo_move', expect.anything());
      // A 3 px wiggle is a tap: the click moves the stack.
      fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 });
      act(() => { ptr('pointermove', 13, 10); ptr('pointerup', 13, 10); });
      fireEvent.click(tile);
      expect(send).toHaveBeenLastCalledWith('cargo_move', { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { alloy: 20 } } });
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('slice 17: no switches on storage that is not yours', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state()));
    expect(screen.queryByTestId('auto-unload-ship')).toBeNull();
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

  it('cargo-pods slice 13: a peek lists found stacks with no Take, keeps Break in, shows the search', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      takeable: false, ship: null, message: 'Locked. That cargo is not yours. You can only look.',
      hidden: 2, revealInMs: 900, breakIn: { pct: null, durationMs: 12_000 },
    })));
    expect(screen.getAllByTestId('cargo-here-row')).toHaveLength(1);
    expect(screen.queryByTestId('cargo-take-all')).toBeNull();
    expect(screen.queryByTestId('cargo-aboard-row')).toBeNull();
    expect(screen.getByTestId('cargo-locked').textContent).toContain('only look');
    expect(screen.getByTestId('cargo-break-in')).toBeTruthy();
    expect(screen.getByTestId('cargo-hidden').getAttribute('data-hidden')).toBe('2');
  });

  it('ignores a reply for a different structure', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ entityId: 10 })));
    expect(screen.queryByTestId('cargo-here-row')).toBeNull();
  });
});
