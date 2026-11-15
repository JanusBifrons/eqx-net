/**
 * RTS slice 10 — the indicator says "Command view" in plain language (was
 * "Spectating"), only in command view and only in-game.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpectatorIndicator } from './SpectatorIndicator.js';

describe('SpectatorIndicator — Command view (RTS slice 10)', () => {
  beforeEach(() => useUIStore.setState({ phase: 'game', pilotMode: 'pilot' }));

  it('shows "Command view" in command view', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<SpectatorIndicator />);
    expect(screen.getByTestId('spectator-indicator')).toHaveTextContent('Command view');
  });

  it('is hidden while flying and outside the game', () => {
    const { rerender } = render(<SpectatorIndicator />);
    expect(screen.queryByTestId('spectator-indicator')).toBeNull();
    useUIStore.setState({ pilotMode: 'spectator', phase: 'galaxy-map' });
    rerender(<SpectatorIndicator />);
    expect(screen.queryByTestId('spectator-indicator')).toBeNull();
  });
});
