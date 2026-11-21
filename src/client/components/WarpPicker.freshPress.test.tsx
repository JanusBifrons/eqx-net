/**
 * Owner bug (phone playtest 2026-11-21): the press that opens the warp menu
 * also picked a destination. The finger lands on the dial's Warp button
 * (touchstart opens the picker), and on release the browser's synthesized
 * click lands on whatever row now sits under the finger, so the ship warped.
 * Picking needs a fresh, full press on the option after the menu is open
 * (down AND up), and nothing counts in the first MENU_ARM_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const requestWarp = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'p1', ships: new Map([['p1', { x: 0, y: 0 }]]) },
    requestWarp: (x: number, y: number) => requestWarp(x, y),
    cancelWarp: () => undefined,
    hasWarpRequest: () => false,
  }),
}));

import { WarpPicker } from './WarpPicker';
import { MENU_ARM_MS } from './touchClickActivate';
import { useUIStore } from '../state/store';
import { warpDestinations } from './warpDestinations';

const target = (): { id: string } => warpDestinations('sol-prime', 0, 0).find((d) => !d.here)!;
/** A tap's synthesized click carries detail 1 (a keyboard click carries 0). */
const tapClick = (el: Element): void => { fireEvent.click(el, { detail: 1 }); };

beforeEach(() => {
  vi.useFakeTimers();
  requestWarp.mockClear();
  useUIStore.setState({ currentSectorKey: 'sol-prime', warpPickerOpen: false, warpHeldTo: null });
  window.history.replaceState(null, '', '/?warpui=list');
});
afterEach(() => { useUIStore.setState({ warpPickerOpen: false }); vi.useRealTimers(); });

/** The opening press: down on the dial's Warp button opens the picker. */
function openByPress(): void {
  render(<WarpPicker />);
  act(() => { useUIStore.getState().setWarpPickerOpen(true); });
}

describe('WarpPicker: the opening press never picks', () => {
  it('the release of the opening press (click with no down on the row) is ignored', () => {
    openByPress();
    const row = screen.getByTestId(`warp-dest-${target().id}`);
    tapClick(row); // same finger lifts over the row
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 50); });
    tapClick(row); // still no fresh down on the row
    expect(requestWarp).not.toHaveBeenCalled();
    expect(useUIStore.getState().warpPickerOpen).toBe(true);
  });

  it('a full press inside the arming delay is ignored', () => {
    openByPress();
    const row = screen.getByTestId(`warp-dest-${target().id}`);
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS - 100); });
    fireEvent.pointerDown(row);
    tapClick(row);
    expect(requestWarp).not.toHaveBeenCalled();
  });

  it('a fresh full press after the menu is armed picks', () => {
    openByPress();
    const row = screen.getByTestId(`warp-dest-${target().id}`);
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 10); });
    fireEvent.pointerDown(row);
    tapClick(row);
    expect(requestWarp).toHaveBeenCalledTimes(1);
  });

  it('a press that starts on one row and ends on another picks neither', () => {
    openByPress();
    const dests = warpDestinations('sol-prime', 0, 0).filter((d) => !d.here);
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 10); });
    fireEvent.pointerDown(screen.getByTestId(`warp-dest-${dests[0]!.id}`));
    tapClick(screen.getByTestId(`warp-dest-${dests[1]!.id}`));
    expect(requestWarp).not.toHaveBeenCalled();
  });

  it('keyboard activation (click with detail 0) still picks', () => {
    openByPress();
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 10); });
    fireEvent.click(screen.getByTestId(`warp-dest-${target().id}`));
    expect(requestWarp).toHaveBeenCalledTimes(1);
  });

  it('map: the opening release does not pick a pocket; a fresh press does', () => {
    window.history.replaceState(null, '', '/?warpui=map');
    openByPress();
    const pocket = screen.getByTestId(`warp-map-${target().id}`);
    const go = screen.getByTestId('warp-map-go') as HTMLButtonElement;
    tapClick(pocket);
    expect(go.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 10); });
    fireEvent.pointerDown(pocket); tapClick(pocket);
    expect(go.disabled).toBe(false);
    fireEvent.pointerDown(go); tapClick(go);
    expect(requestWarp).toHaveBeenCalledTimes(1);
  });
});
