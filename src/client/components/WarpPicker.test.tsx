/**
 * Warp destination picker (wrap-up plan W1a): picking a destination asks the
 * client to warp to that pocket's rim, in both prototypes, and a held warp
 * shows a chip with a Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const requestWarp = vi.fn();
const cancelWarp = vi.fn();
let warping = false;
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'p1', ships: new Map([['p1', { x: 0, y: 0 }]]) },
    requestWarp: (x: number, y: number) => { requestWarp(x, y); warping = true; },
    cancelWarp: () => { cancelWarp(); warping = false; },
    hasWarpRequest: () => warping,
  }),
}));

import { WarpPicker, readWarpUi } from './WarpPicker';
import { useUIStore } from '../state/store';
import { warpDestinations } from './warpDestinations';

beforeEach(() => {
  requestWarp.mockClear(); cancelWarp.mockClear(); warping = false;
  useUIStore.setState({ currentSectorKey: 'sol-prime', warpPickerOpen: true });
});
afterEach(() => { useUIStore.setState({ warpPickerOpen: false }); });

describe('WarpPicker', () => {
  it('list: picking a pocket warps to its rim, closes, and shows a cancellable chip', () => {
    render(<WarpPicker />);
    const target = warpDestinations('sol-prime', 0, 0).find((d) => !d.here)!;
    fireEvent.click(screen.getByTestId(`warp-dest-${target.id}`));
    expect(requestWarp).toHaveBeenCalledWith(target.dropX, target.dropY);
    expect(useUIStore.getState().warpPickerOpen).toBe(false);
    expect(screen.getByTestId('warp-status').textContent).toContain(target.label);
    fireEvent.click(screen.getByTestId('warp-cancel'));
    expect(cancelWarp).toHaveBeenCalled();
  });

  it("list: the pocket you're in can't be picked", () => {
    render(<WarpPicker />);
    const home = warpDestinations('sol-prime', 0, 0).find((d) => d.here)!;
    expect((screen.getByTestId(`warp-dest-${home.id}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('map: tap a pocket, then Warp', () => {
    window.history.replaceState(null, '', '/?warpui=map');
    render(<WarpPicker />);
    const target = warpDestinations('sol-prime', 0, 0).find((d) => !d.here)!;
    expect((screen.getByTestId('warp-map-go') as HTMLButtonElement).disabled).toBe(true);
    act(() => { fireEvent.click(screen.getByTestId(`warp-map-${target.id}`)); });
    fireEvent.click(screen.getByTestId('warp-map-go'));
    expect(requestWarp).toHaveBeenCalledWith(target.dropX, target.dropY);
    window.history.replaceState(null, '', '/');
  });

  it('reads the prototype from the URL', () => {
    expect(readWarpUi('?warpui=map')).toBe('map');
    expect(readWarpUi('')).toBe('list');
  });
});
