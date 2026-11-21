/**
 * Build menu (build-menu redesign M1): the dial's Build action opens the Build
 * sidebar; picking a building hides it, so it never covers the ghost while it
 * is placed (stills review 2026-11-20); Confirm brings it back on the same
 * category for the next structure (the R2.6 repeat-build need).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';

const expanded = (): string | null => screen.getByTestId('speed-dial-fab').getAttribute('aria-expanded');
const sidebarOpen = (): boolean => screen.queryByTestId('build-rail') !== null;

describe('SpeedDialMenu: the Build sidebar', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false });
  });

  it('Build closes the dial and opens the sidebar; a pick hides it and keeps the category', () => {
    render(<SpeedDialMenu direction="down" />);
    expect(sidebarOpen()).toBe(false);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    expect(expanded()).toBe('false');
    expect(sidebarOpen()).toBe(true);

    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(screen.getByTestId('build-solar'));
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(false);

    // Confirm: the sidebar comes straight back on the same category.
    act(() => useUIStore.getState().setPlacementKind(null));
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
  });

  it('the switch Build button opens the sidebar; leaving Build closes it', () => {
    render(<SpeedDialMenu direction="down" />);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(sidebarOpen()).toBe(true);
    expect(expanded()).toBe('false');
    expect(screen.getByTestId('build-cat-economy')).toBeTruthy();
    act(() => useUIStore.getState().setBuildMode(false));
    expect(sidebarOpen()).toBe(false);
  });

  it('the sidebar ✕ closes it and Build mode stays', () => {
    render(<SpeedDialMenu direction="down" />);
    act(() => useUIStore.getState().setBuildMode(true));
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().buildMode).toBe(true);
  });
});
