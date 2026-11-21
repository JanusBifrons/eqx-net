/**
 * RTS slice 10 — the indicator says "Command view" in plain language (was
 * "Spectating"), only in command view and only in-game.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { ControlModeBadge, SpectatorIndicator } from './SpectatorIndicator.js';
import { LayoutContext } from '../layout/useLayout.js';

describe('SpectatorIndicator — Command view (RTS slice 10)', () => {
  // A joined, ready sector (the loading screen hides the chip: loadingChrome.test.tsx).
  beforeEach(() => useUIStore.setState({
    phase: 'game', pilotMode: 'pilot', buildMode: false, loadingCosmeticOnly: false,
    connectionStatus: 'connected', localShipInstanceId: 'ship-1', firstSnapshotApplied: true,
    rendererFirstFrameRendered: true, joinMinimumElapsed: true, localPoseResolved: true,
    clientReadySent: true, arrivalTickFromServer: 100, arrivalAcked: true,
  }));

  it('reads "Build mode" (not Command view) in Build mode', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true });
    render(<SpectatorIndicator />);
    expect(screen.getByTestId('build-mode-indicator')).toHaveTextContent('Build mode');
    expect(screen.queryByTestId('spectator-indicator')).toBeNull();
  });

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

  // The badge is display-only, but its Slot wrapper used to default to
  // pointer-events:auto, so the top-centre chip swallowed Command-view
  // right-click move orders and selection clicks aimed just below the HUD
  // (fleet-command e2e, PR #1098). Clicks must fall through to the map.
  it('never catches map clicks (its slot wrapper is click-through)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    const top = document.createElement('div');
    const left = document.createElement('div');
    document.body.append(top, left);
    render(
      <LayoutContext.Provider value={{ 'top-center': top, 'top-left': left }}>
        <ControlModeBadge />
      </LayoutContext.Provider>,
    );
    const badge = screen.getByTestId('spectator-indicator');
    for (let el: HTMLElement | null = badge; el && el !== top; el = el.parentElement) {
      expect(getComputedStyle(el).pointerEvents).toBe('none');
    }
    top.remove(); left.remove();
  });
});
