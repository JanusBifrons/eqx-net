/**
 * Phase 5 — the ALWAYS-VISIBLE Pilot ⇄ Spectate toggle (moved OUT of the
 * speed-dial per the user: "it was NOT designed to be part of the speeddial…
 * visible at all times"). Locks:
 *   - renders both joined buttons while `phase === 'game'`, null otherwise;
 *   - clicking Spectate / Pilot round-trips `pilotMode` without touching
 *     `isDead` (spectator is a free-roam camera, not death);
 *   - the active mode is reflected on the selected button (aria-pressed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { PilotSpectatorToggle } from './PilotSpectatorToggle.js';

describe('PilotSpectatorToggle (Phase 5)', () => {
  beforeEach(() => {
    useUIStore.setState({ phase: 'game', pilotMode: 'pilot', isDead: false });
  });

  it('renders both joined buttons while phase === "game"', () => {
    render(<PilotSpectatorToggle />);
    expect(screen.getByTestId('pilot-spectator-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('pilot-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('spectator-toggle')).toBeInTheDocument();
  });

  it('renders nothing when phase !== "game"', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<PilotSpectatorToggle />);
    expect(screen.queryByTestId('pilot-spectator-toggle')).toBeNull();
  });

  it('clicking Spectate / Pilot round-trips pilotMode without touching isDead', () => {
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('spectator-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);

    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('pilot');
    expect(useUIStore.getState().isDead).toBe(false);
  });

  it('reflects the active mode on the selected button (aria-pressed)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<PilotSpectatorToggle />);
    expect(screen.getByTestId('spectator-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pilot-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});
