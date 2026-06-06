/**
 * Auto-fire toggle (weapon-autofire-boost-mechanics, Part B4).
 *
 * Small chip bound to the persisted `autoFireEnabled` Zustand flag. Locks:
 *   - renders with data-state reflecting the flag (default ON),
 *   - click flips the flag (and persists via the store setter),
 *   - hidden while dead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { AutoFireToggleButton } from './AutoFireToggleButton.js';

describe('AutoFireToggleButton', () => {
  beforeEach(() => {
    useUIStore.setState({ autoFireEnabled: true, isDead: false });
  });

  it('renders ON by default (data-state=on)', () => {
    render(<AutoFireToggleButton />);
    const btn = screen.getByTestId('auto-fire-toggle');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('data-state', 'on');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('click toggles auto-fire OFF and updates the store', () => {
    render(<AutoFireToggleButton />);
    const btn = screen.getByTestId('auto-fire-toggle');
    fireEvent.click(btn);
    expect(useUIStore.getState().autoFireEnabled).toBe(false);
    expect(screen.getByTestId('auto-fire-toggle')).toHaveAttribute('data-state', 'off');
  });

  it('click again toggles back ON', () => {
    useUIStore.setState({ autoFireEnabled: false });
    render(<AutoFireToggleButton />);
    fireEvent.click(screen.getByTestId('auto-fire-toggle'));
    expect(useUIStore.getState().autoFireEnabled).toBe(true);
  });

  it('is hidden while dead', () => {
    useUIStore.setState({ isDead: true });
    render(<AutoFireToggleButton />);
    expect(screen.queryByTestId('auto-fire-toggle')).toBeNull();
  });
});
