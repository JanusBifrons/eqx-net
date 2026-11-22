/**
 * Build menu (build-menu redesign M1; UI language plan U2-1): the Build panel is
 * open while `rightPanel === 'build'`. Entering Build opens nothing; the rail's
 * Build item (or a Build tap while in Build) opens it. Picking a building hides it, so it never covers the ghost while it
 * is placed (stills review 2026-11-20). Confirm KEEPS placing the same building
 * with it hidden (M3); Cancel, or a place-once kind placed, brings it back on
 * the same category for the next structure (the R2.6 repeat-build need).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebarHost } from './BuildSidebarHost.js';
import { requestBuildPanel } from '../panels/BuildPanel.js';
import { cancelPlacement, commitPlacement } from '../structures/placementCancel.js';

// Confirm sends nothing here: the commit is stubbed as sent.
vi.mock('../structures/structurePlacementClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../structures/structurePlacementClient.js')>()),
  commitChosenPlacement: () => true,
}));

const sidebarOpen = (): boolean => screen.queryByTestId('build-rail') !== null;

describe('BuildSidebarHost: the Build sidebar', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false, rightPanel: null });
  });

  it('entering Build opens nothing; the Build item opens it; a pick hides it and keeps the category', () => {
    render(<BuildSidebarHost />);
    expect(sidebarOpen()).toBe(false);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(sidebarOpen()).toBe(false); // no auto-open
    act(() => useUIStore.getState().setRightPanel('build')); // the rail's Build item
    expect(sidebarOpen()).toBe(true);

    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(screen.getByTestId('build-solar').querySelector('button')!); // the tile's button, as a tap hits it
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().rightPanel).toBeNull();

    // Confirm keeps placing the solar panel; the sidebar stays hidden.
    act(() => { commitPlacement('solar'); });
    act(() => { commitPlacement('solar'); });
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(sidebarOpen()).toBe(false);

    // Cancel: the sidebar comes straight back on the same category.
    act(() => cancelPlacement());
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(sidebarOpen()).toBe(true);
    expect(useUIStore.getState().rightPanel).toBe('build');
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
  });

  it('a place-once kind (the Capital) ends placement on Confirm and brings the sidebar back', () => {
    render(<BuildSidebarHost />);
    useUIStore.setState({ packedStock: null });
    act(() => { useUIStore.getState().setBuildMode(true); requestBuildPanel(); });
    fireEvent.click(screen.getByTestId('build-cat-core'));
    fireEvent.click(screen.getByTestId('build-capital').querySelector('button')!); // the tile's button, as a tap hits it
    expect(useUIStore.getState().placementKind).toBe('capital');
    expect(sidebarOpen()).toBe(false);
    act(() => { commitPlacement('capital'); });
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'core');
  });

  it('a Build tap while in Build opens the panel; leaving Build closes it and clears the flag', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    act(() => requestBuildPanel());
    expect(sidebarOpen()).toBe(true);
    expect(screen.getByTestId('build-cat-economy')).toBeTruthy();
    act(() => useUIStore.getState().setBuildMode(false));
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('the sidebar ✕ closes it, Build mode stays, and a Build tap brings it back', () => {
    render(<BuildSidebarHost />);
    act(() => { useUIStore.getState().setBuildMode(true); requestBuildPanel(); });
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(useUIStore.getState().rightPanel).toBeNull();
    act(() => requestBuildPanel());
    expect(sidebarOpen()).toBe(true);
  });

  it('a Build request outside Build mode opens nothing', () => {
    render(<BuildSidebarHost />);
    act(() => requestBuildPanel());
    expect(sidebarOpen()).toBe(false);
    expect(useUIStore.getState().rightPanel).toBeNull();
  });
});
