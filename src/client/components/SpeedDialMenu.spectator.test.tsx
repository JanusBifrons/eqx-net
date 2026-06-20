/**
 * Phase 4 WS-A1 — pilot↔spectator toggle on the speed-dial (D7).
 *
 * Spectator mode (D3/D4) is entered instantly on death (no modal) and also via
 * a deliberate pilot↔spectator toggle on the consolidated SpeedDialMenu. This
 * locks the toggle action:
 *   - it renders only while `phase === 'game'` (gated — it makes no sense on the
 *     galaxy-map / auth / connecting screens);
 *   - tapping it round-trips `pilotMode` pilot↔spectator without touching
 *     `isDead` (spectator is a free-roam construction camera, not death).
 *
 * The free-roam camera + input swap themselves are exercised by the E2E
 * (`tests/e2e/spectator-mode.spec.ts`); this is the fail-first component lock
 * for the toggle affordance.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { SpeedDialMenu } from './SpeedDialMenu.js';

describe('SpeedDialMenu — pilot↔spectator toggle (Phase 4 WS-A1)', () => {
  beforeEach(() => {
    // phase==='game' gates the HUD on game-readiness (computeIsLoadingActive),
    // so flip every readiness gate true → the dial renders.
    useUIStore.setState({
      phase: 'game',
      isDead: false,
      isGalaxyMapOpen: false,
      pilotMode: 'pilot',
      connectionStatus: 'connected',
      localShipInstanceId: 'ship-1',
      rendererFirstFrameRendered: true,
      firstSnapshotApplied: true,
      joinMinimumElapsed: true,
      localPoseResolved: true,
      clientReadySent: true,
      arrivalTickFromServer: 0,
      arrivalAcked: true,
      loadingCosmeticOnly: false,
    });
  });

  function openDial(): void {
    fireEvent.click(screen.getByTestId('speed-dial-fab'));
  }

  it('renders the spectator toggle while phase === "game"', () => {
    render(<SpeedDialMenu />);
    openDial();
    expect(screen.getByTestId('spectator-toggle')).toBeInTheDocument();
  });

  it('does NOT render the toggle when phase !== "game"', () => {
    // The dial itself can mount on other phases (useShouldRenderHud), but the
    // spectator toggle is gated explicitly to phase==='game' — it makes no
    // sense on the galaxy-map / connecting screens. Open the dial and assert
    // the toggle action is absent.
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<SpeedDialMenu />);
    openDial();
    expect(screen.queryByTestId('spectator-toggle')).toBeNull();
  });

  it('toggles pilotMode pilot↔spectator without touching isDead', () => {
    render(<SpeedDialMenu />);
    openDial();

    const toggle = screen.getByTestId('spectator-toggle');
    fireEvent.click(toggle);
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);

    // Re-open (the terminal action closes the dial) and toggle back.
    openDial();
    fireEvent.click(screen.getByTestId('spectator-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('pilot');
    expect(useUIStore.getState().isDead).toBe(false);
  });

  it('reflects the current mode via aria-pressed', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<SpeedDialMenu />);
    openDial();
    expect(screen.getByTestId('spectator-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});
