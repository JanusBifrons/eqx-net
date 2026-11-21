/**
 * Cancelling a placement folds the build list shut (phone landscape 863x360,
 * Build mode, 2026-11-21 run).
 *
 * Bug: Build ▸ Economy ▸ Solar Panel, then Cancel. The Economy list stayed
 * open and covered the base behind it (a tap on the shipyard under the list
 * did nothing). Confirm still brings the list back for the next structure
 * (SpeedDialMenu.pick.test.tsx); Cancel closes it, keeping the kinds level so
 * one FAB tap brings the same list back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';
import { cancelPlacement } from '../structures/placementCancel.js';

const expanded = (): string | null => screen.getByTestId('speed-dial-fab').getAttribute('aria-expanded');

function pickSolar(): void {
  render(<SpeedDialMenu direction="down" />);
  fireEvent.click(screen.getByTestId('speed-dial-fab'));
  fireEvent.click(screen.getByTestId('speed-dial-build'));
  fireEvent.click(screen.getByTestId('build-cat-economy'));
  fireEvent.click(screen.getByTestId('build-solar'));
}

describe('SpeedDialMenu: cancelling a placement', () => {
  beforeEach(() => {
    cleanup();
    useUIStore.setState({ phase: 'galaxy-map', isDead: false, placementKind: null, buildMode: false });
  });

  it('Cancel closes the build list and stays in Build', () => {
    pickSolar();
    expect(expanded()).toBe('false');
    act(() => cancelPlacement());
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(expanded()).toBe('false');
  });

  it('Cancel with the list reopened over the ghost closes it too', () => {
    pickSolar();
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(expanded()).toBe('true');
    act(() => cancelPlacement());
    expect(expanded()).toBe('false');
  });

  it('after a Cancel one FAB tap brings the same kinds list back', () => {
    pickSolar();
    act(() => cancelPlacement());
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    expect(expanded()).toBe('true');
    expect(screen.getByTestId('build-solar')).toBeTruthy();
  });

  it('a Confirm after a Cancel still brings the list straight back', () => {
    pickSolar();
    act(() => cancelPlacement());
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
    fireEvent.click(screen.getByTestId('build-solar'));
    act(() => useUIStore.getState().setPlacementKind(null)); // Confirm
    expect(expanded()).toBe('true');
  });
});
