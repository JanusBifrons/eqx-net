/**
 * Picking a building folds the Build sidebar to the placing strip (not closed):
 * the portrait expands it with placement live, a new pick folds it back on the
 * new kind, the full sidebar's ✕ while placing folds it, the strip's ✕ cancels
 * (the full list comes back), and a game window or leaving Build closes it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BuildSidebarHost } from './BuildSidebarHost.js';
import { commitPlacement } from '../structures/placementCancel.js';
import { buildMenuKeysOpen } from '../input/buildMenuKeys.js';

vi.mock('../structures/structurePlacementClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../structures/structurePlacementClient.js')>()),
  commitChosenPlacement: () => true,
}));

const mode = (): string | null =>
  document.querySelector('[data-testid="build-sidebar"] .MuiDrawer-paper')?.getAttribute('data-mode') ?? null;
const strip = (): HTMLElement | null => screen.queryByTestId('build-strip');
const full = (): boolean => screen.queryByTestId('build-rail') !== null;

function pick(cat: string, kind: string): void {
  fireEvent.click(screen.getByTestId(`build-cat-${cat}`));
  fireEvent.click(screen.getByTestId(`build-${kind}`).querySelector('button')!);
}

describe('BuildSidebarHost: the placing strip', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false, packedStock: null });
  });

  it('a pick folds the sidebar to the strip with the picked kind; Confirm keeps it', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    expect(mode()).toBe('full');
    pick('economy', 'solar');
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(full()).toBe(false);
    expect(mode()).toBe('strip');
    expect(strip()).toHaveAttribute('data-kind', 'solar');
    expect(buildMenuKeysOpen()).toBe(false);
    act(() => { commitPlacement('solar'); });
    expect(strip()).toHaveAttribute('data-kind', 'solar');
  });

  it('the portrait expands with placement live; another pick folds back on the new kind', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    pick('economy', 'solar');
    fireEvent.click(screen.getByTestId('build-strip-portrait').querySelector('button')!);
    expect(full()).toBe(true);
    expect(mode()).toBe('full');
    expect(strip()).toBeNull();
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(buildMenuKeysOpen()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');

    pick('defence', 'turret');
    expect(useUIStore.getState().placementKind).toBe('turret');
    expect(strip()).toHaveAttribute('data-kind', 'turret');
    expect(full()).toBe(false);
  });

  it('the full sidebar ✕ while placing folds to the strip; with nothing placed it closes', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    pick('economy', 'solar');
    fireEvent.click(screen.getByTestId('build-strip-portrait').querySelector('button')!);
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(strip()).toHaveAttribute('data-kind', 'solar');
    expect(useUIStore.getState().placementKind).toBe('solar');

    fireEvent.click(screen.getByTestId('build-strip-cancel'));
    expect(full()).toBe(true);
    fireEvent.click(screen.getByTestId('build-sidebar-close'));
    expect(full()).toBe(false);
    expect(strip()).toBeNull();
  });

  it('the strip ✕ cancels placing and the full list comes back; Build stays', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    pick('economy', 'solar');
    fireEvent.click(screen.getByTestId('build-strip-cancel'));
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(strip()).toBeNull();
    expect(full()).toBe(true);
    expect(screen.getByTestId('build-kinds')).toHaveAttribute('data-category', 'economy');
  });

  it('a place-once kind ends placement: the strip goes, the full list comes back', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    pick('core', 'capital');
    expect(strip()).toHaveAttribute('data-kind', 'capital');
    act(() => { commitPlacement('capital'); });
    expect(strip()).toBeNull();
    expect(full()).toBe(true);
  });

  it('leaving Build closes the strip', () => {
    render(<BuildSidebarHost />);
    act(() => useUIStore.getState().setBuildMode(true));
    pick('economy', 'solar');
    act(() => { useUIStore.getState().setPlacementKind(null); useUIStore.getState().setBuildMode(false); });
    expect(strip()).toBeNull();
    expect(full()).toBe(false);
  });
});
