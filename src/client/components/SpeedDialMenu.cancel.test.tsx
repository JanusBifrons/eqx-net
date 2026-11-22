/**
 * Cancelling a placement brings the Build sidebar back (build-menu redesign
 * M1): the ghost goes, Build stays, and the same category is ready for the
 * next structure. Escape cancels the placement only: one press does one thing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { cancelPlacement } from '../structures/placementCancel.js';

const sidebarOpen = (): boolean => screen.queryByTestId('build-rail') !== null;

function pickSolar(): void {
  render(<SpeedDialMenu direction="down" />);
  act(() => useUIStore.getState().setBuildMode(true)); // Build mode: the only way in
  fireEvent.click(screen.getByTestId('build-cat-economy'));
  fireEvent.click(screen.getByTestId('build-solar').querySelector('button')!); // the tile's button, as a tap hits it
}

describe('SpeedDialMenu: cancelling a placement', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false, fleetPick: null });
  });

  it('Cancel brings the sidebar back on the same category and stays in Build', () => {
    pickSolar();
    expect(sidebarOpen()).toBe(false);
    act(() => cancelPlacement());
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
  });

  it('an Esc already handled (App cancels the placement) does not close the sidebar', () => {
    pickSolar();
    act(() => cancelPlacement());
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    e.preventDefault(); // App.tsx keydown marks its Esc handled
    act(() => { window.dispatchEvent(e); });
    expect(sidebarOpen()).toBe(true);
    // The next Esc press closes it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sidebarOpen()).toBe(false);
  });
});
