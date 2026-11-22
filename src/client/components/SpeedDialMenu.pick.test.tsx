/**
 * Build menu (build-menu redesign M1): entering Build mode opens the Build
 * sidebar (the dial no longer builds, owner 2026-11-22); picking a building hides it, so it never covers the ghost while it
 * is placed (stills review 2026-11-20). Confirm KEEPS placing the same building
 * with it hidden (M3); Cancel, or a place-once kind placed, brings it back on
 * the same category for the next structure (the R2.6 repeat-build need).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { requestBuildSidebar } from './BuildSidebar.js';
import { cancelPlacement, commitPlacement } from '../structures/placementCancel.js';

// Confirm sends nothing here: the commit is stubbed as sent.
vi.mock('../structures/structurePlacementClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../structures/structurePlacementClient.js')>()),
  commitChosenPlacement: () => true,
}));

const expanded = (): string | null => screen.getByTestId('speed-dial-fab').getAttribute('aria-expanded');
const sidebarOpen = (): boolean => screen.queryByTestId('build-rail') !== null;

describe('SpeedDialMenu: the Build sidebar', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false });
  });

  it('the dial has no Build entry: one way to build (owner 2026-11-22)', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(expanded()).toBe('true');
    expect(screen.queryByTestId('speed-dial-build')).toBeNull();
    expect(sidebarOpen()).toBe(false);
  });

  it('entering Build opens the sidebar; a pick hides it and keeps the category', () => {
    render(<SpeedDialMenu direction="down" />);
    expect(sidebarOpen()).toBe(false);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(sidebarOpen()).toBe(true);

    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(screen.getByTestId('build-solar').querySelector('button')!); // the tile's button, as a tap hits it
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(false);

    // Confirm keeps placing the solar panel; the sidebar stays hidden.
    act(() => { commitPlacement('solar'); });
    act(() => { commitPlacement('solar'); });
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(sidebarOpen()).toBe(false);

    // Cancel: the sidebar comes straight back on the same category.
    act(() => cancelPlacement());
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
  });

  it('a place-once kind (the Capital) ends placement on Confirm and brings the sidebar back', () => {
    render(<SpeedDialMenu direction="down" />);
    useUIStore.setState({ packedStock: null });
    act(() => useUIStore.getState().setBuildMode(true));
    fireEvent.click(screen.getByTestId('build-cat-core'));
    fireEvent.click(screen.getByTestId('build-capital').querySelector('button')!); // the tile's button, as a tap hits it
    expect(useUIStore.getState().placementKind).toBe('capital');
    expect(sidebarOpen()).toBe(false);
    act(() => { commitPlacement('capital'); });
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'core');
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

  it('the sidebar ✕ closes it, Build mode stays, and a Build tap brings it back', () => {
    render(<SpeedDialMenu direction="down" />);
    act(() => useUIStore.getState().setBuildMode(true));
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().buildMode).toBe(true);
    act(() => requestBuildSidebar());
    expect(sidebarOpen()).toBe(true);
  });

  it('a Build request outside Build mode opens nothing', () => {
    render(<SpeedDialMenu direction="down" />);
    act(() => requestBuildSidebar());
    expect(sidebarOpen()).toBe(false);
  });
});
