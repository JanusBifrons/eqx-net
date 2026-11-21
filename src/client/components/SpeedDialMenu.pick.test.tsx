/**
 * Build mode (stills review 2026-11-20, sideways phone): picking a building
 * closes the dial, so its list no longer covers the right third of the screen
 * while the ghost is placed. The drilled kinds level is kept, so the next
 * structure is one FAB tap away (the R2.6 repeat-build need).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';

const expanded = (): string | null => screen.getByTestId('speed-dial-fab').getAttribute('aria-expanded');

describe('SpeedDialMenu: picking a building', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false });
  });

  it('closes the dial and keeps the kinds level for the next pick', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    expect(expanded()).toBe('true');

    fireEvent.click(screen.getByTestId('build-solar'));
    expect(useUIStore.getState().placementKind).toBe('solar');
    expect(expanded()).toBe('false');

    // One FAB tap brings back the same kinds list (no Build ▸ category re-drill).
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(expanded()).toBe('true');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
    expect(screen.queryByTestId('build-cat-economy')).toBeNull();
  });

  it('a pick enters Build; Confirm brings the build list straight back (stay in Build)', () => {
    render(<SpeedDialMenu direction="down" />);
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('speed-dial-build'));
    fireEvent.click(screen.getByTestId('build-cat-economy'));
    fireEvent.click(screen.getByTestId('build-solar'));
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(expanded()).toBe('false');
    act(() => useUIStore.getState().setPlacementKind(null)); // Confirm / Cancel
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(expanded()).toBe('true');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
  });

  it('the switch Build button opens the category list; leaving Build closes it', () => {
    render(<SpeedDialMenu direction="down" />);
    expect(expanded()).toBe('false');
    act(() => useUIStore.getState().setBuildMode(true));
    expect(expanded()).toBe('true');
    expect(screen.getByTestId('build-cat-economy')).toBeTruthy();
    act(() => useUIStore.getState().setBuildMode(false));
    expect(expanded()).toBe('false');
  });
});
