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

  it('a pod has no capacity: its pane shows the weight inside, never "/0"', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ used: 20, capacity: 0 })));
    expect(screen.getByTestId('cargo-here-weight').textContent).toBe('20');
    expect(screen.getByTestId('cargo-panel').textContent).not.toContain('/ 0');
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

  it('T4: an NPC Freight Dock is one list of its own goods — stock, buy, sell in fixed columns; no hold pane', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      hold: { goods: { alloy: 20 }, blueprints: [], packed: [{ product: 'hull:capital', quality: 50 }] },
      market: { buy: { alloy: 12 }, sell: { alloy: 9, salvage: 2 }, packed: { 'hull:capital': 900 } },
    })));
    expect(screen.getByTestId('cargo-panel').getAttribute('data-market')).toBe('1');
    expect(screen.queryByTestId('cargo-aboard-list')).toBeNull();
    expect(screen.queryByTestId('cargo-aboard-row')).toBeNull();
    const alloy = screen.getByTestId('trade-row-alloy');
    expect(alloy.querySelector('[data-testid="trade-stock"]')!.textContent).toBe('20');
    expect(alloy.querySelector('[data-testid="trade-buy-price"]')!.textContent).toBe('12¢');
    expect(alloy.querySelector('[data-testid="trade-sell-price"]')!.textContent).toBe('9¢');
    // Salvage: the dock buys it but sells none: "—" in the buy column, you carry 3 so sell is live.
    const salvage = screen.getByTestId('trade-row-salvage');
    expect(salvage.querySelector('[data-testid="trade-buy-price"]')!.textContent).toBe('—');
    expect((screen.getByTestId('trade-buy-salvage') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('trade-sell-salvage') as HTMLButtonElement).disabled).toBe(false);
    // You carry no alloy: nothing to sell.
    expect((screen.getByTestId('trade-sell-alloy') as HTMLButtonElement).disabled).toBe(true);
    // The packed Capital is for sale (buy only).
    const cap = screen.getByTestId('trade-row-hull:capital');
    expect(cap.querySelector('[data-testid="trade-buy-price"]')!.textContent).toBe('900¢');
    expect(cap.getAttribute('data-stock')).toBe('1');
    // Same column template on every row.
    expect(getComputedStyle(alloy).gridTemplateColumns).toBe(getComputedStyle(cap).gridTemplateColumns);
    expect(send).not.toHaveBeenCalledWith('cargo_move', expect.anything());
  });

  it('T4: tapping buy/sell fills a basket; Confirm sends the sells, then the buys, on cargo_move; ok clears it', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: { salvage: 2 } } })));
    expect((screen.getByTestId('trade-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    expect(screen.getByTestId('trade-confirm').textContent).toBe('Purchase');
    fireEvent.click(screen.getByTestId('trade-sell-salvage'));
    expect(screen.getByTestId('trade-basket').getAttribute('data-lines')).toBe('2');
    expect(screen.getByTestId('trade-line-buy-alloy').getAttribute('data-qty')).toBe('2');
    expect(screen.getByTestId('trade-confirm').textContent).toBe('Confirm');
    expect(screen.getByTestId('trade-net').getAttribute('data-net')).toBe('-22');
    send.mockReset();
    fireEvent.click(screen.getByTestId('trade-confirm'));
    expect(send.mock.calls.map((c) => c[1])).toEqual([
      { type: 'cargo_move', entityId: 9, dir: 'put', items: { goods: { salvage: 1 } } },
      { type: 'cargo_move', entityId: 9, dir: 'take', items: { goods: { alloy: 2 } } },
    ]);
    act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: { salvage: 2 } }, ok: true, message: 'Sold.' })));
    expect(screen.getByTestId('trade-basket').getAttribute('data-lines')).toBe('1');
    act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: { salvage: 2 } }, ok: true, message: 'Bought.' })));
    expect(screen.getByTestId('trade-basket').getAttribute('data-lines')).toBe('0');
  });

  it("T4: a deal that won't fit the hold is refused before sending, with the reason", () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ shipCapacity: 0, market: { buy: { alloy: 12 }, sell: {} } })));
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    expect((screen.getByTestId('trade-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('trade-why').textContent).toMatch(/^Won't fit: needs [\d.]+ more space$/);
  });

  it('T4: on a short, wide screen the dock list and basket sit side by side; a tall one stacks them', () => {
    const w0 = window.innerWidth;
    const h0 = window.innerHeight;
    try {
      Object.assign(window, { innerWidth: 863, innerHeight: 390 });
      const r = render(<CargoPanel entityId={9} />);
      act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: {} } })));
      const body = screen.getByTestId('trade-body');
      expect(body.getAttribute('data-layout')).toBe('side');
      expect(getComputedStyle(body).flexDirection).toBe('row');
      const basket = getComputedStyle(screen.getByTestId('trade-basket'));
      expect(basket.overflowY).toBe('auto');
      expect(basket.maxHeight).not.toBe('40%');
      r.unmount();
      Object.assign(window, { innerWidth: 1024, innerHeight: 900 });
      render(<CargoPanel entityId={9} />);
      act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: {} } })));
      expect(screen.getByTestId('trade-body').getAttribute('data-layout')).toBe('stack');
    } finally {
      Object.assign(window, { innerWidth: w0, innerHeight: h0 });
    }
  });

  it('T4: the wallet stays in the footer once the basket has items', () => {
    act(() => useUIStore.getState().setWallet(20000));
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: {} } })));
    expect(screen.getByTestId('trade-net').textContent).toBe('Wallet 20000¢');
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    expect(screen.getByTestId('trade-net').textContent).toBe('Pay 12¢ of 20000¢');
    expect(screen.getByTestId('trade-hold-after').textContent).toMatch(/^Hold [\d.]+\/300$/);
    act(() => useUIStore.getState().setWallet(null));
  });

  it('T4: the stock and your own count go down as you fill the basket; buy greys at zero', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      hold: { goods: { alloy: 2 }, blueprints: [] }, market: { buy: { alloy: 12 }, sell: { salvage: 2 } },
    })));
    const stock = (): string => screen.getByTestId('trade-row-alloy').querySelector('[data-testid="trade-stock"]')!.textContent!;
    expect(stock()).toBe('2');
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    expect(stock()).toBe('1');
    fireEvent.click(screen.getByTestId('trade-buy-alloy'));
    expect(stock()).toBe('0');
    expect((screen.getByTestId('trade-buy-alloy') as HTMLButtonElement).disabled).toBe(true);
    // Sell side: you carry 3 salvage; each one in the basket leaves one fewer.
    expect(screen.getByTestId('trade-row-salvage').getAttribute('data-aboard')).toBe('3');
    fireEvent.click(screen.getByTestId('trade-sell-salvage'));
    expect(screen.getByTestId('trade-row-salvage').getAttribute('data-aboard')).toBe('2');
  });

  it('T4: a long name in the basket wraps and shows whole, never cut with an ellipsis', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({
      hold: { goods: {}, blueprints: [], packed: [{ product: 'hull:capital', quality: 50 }] },
      market: { buy: {}, sell: {}, packed: { 'hull:capital': 13000 } },
    })));
    fireEvent.click(screen.getByTestId('trade-buy-hull:capital'));
    const name = screen.getByTestId('trade-line-name');
    expect(name.textContent).toBe('Capital (packed)');
    const css = getComputedStyle(name);
    expect(css.whiteSpace).not.toBe('nowrap');
    expect(css.textOverflow).not.toBe('ellipsis');
  });

  it('the dock list fills the window and scrolls inside its box, never a fixed 110 px', () => {
    render(<CargoPanel entityId={9} />);
    act(() => useUIStore.getState().setCargoState(state({ market: { buy: { alloy: 12 }, sell: { salvage: 2 } } })));
    const css = getComputedStyle(screen.getByTestId('cargo-here-list'));
    expect(css.maxHeight).not.toBe('110px');
    expect(css.flexGrow).toBe('1');
    expect(css.minHeight).toBe('0px');
    expect(css.overflowY).toBe('auto');
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
