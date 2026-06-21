/**
 * Phase 5 — the ALWAYS-VISIBLE Pilot ⇄ Spectate toggle + the pilot DROPDOWN
 * (moved OUT of the speed-dial). Locks:
 *   - renders both joined buttons in-game, null otherwise; aria-pressed reflects
 *     the mode;
 *   - Spectate flips `pilotMode` to spectator (a plain mode flip);
 *   - Pilot WHILE SPECTATING opens a context menu of the player's OWN in-sector
 *     ships (lingering hulls), NOT a direct mode flip; picking one
 *     `sendPilotShip`s it; with no ships it shows the "No ships to pilot"
 *     placeholder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { sendPilotShip } from '../ships/shipActionsClient.js';
import { PilotSpectatorToggle } from './PilotSpectatorToggle.js';

vi.mock('../ships/shipActionsClient.js', () => ({ sendPilotShip: vi.fn() }));

function fakeClient(mirror: Record<string, unknown>): ColyseusGameClient {
  return { mirror } as unknown as ColyseusGameClient;
}

describe('PilotSpectatorToggle (Phase 5)', () => {
  beforeEach(() => {
    useUIStore.setState({ phase: 'game', pilotMode: 'pilot', isDead: false });
    vi.mocked(sendPilotShip).mockReset();
  });
  afterEach(() => setGameClient(null));

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

  it('Spectate flips pilotMode to spectator without touching isDead', () => {
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('spectator-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);
  });

  it('reflects the active mode on the selected button (aria-pressed)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<PilotSpectatorToggle />);
    expect(screen.getByTestId('spectator-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pilot-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Pilot while spectating opens a dropdown of OWN ships; picking one sends pilot_ship', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    setGameClient(
      fakeClient({
        localPlayerId: 'p1',
        lingeringShips: new Map<string, unknown>([
          ['ship-1', { ownerPlayerId: 'p1', kind: 'fighter' }],
          ['ship-2', { ownerPlayerId: 'other', kind: 'scout' }], // NOT mine → excluded
        ]),
      }),
    );
    render(<PilotSpectatorToggle />);
    // Clicking Pilot opens the menu (does NOT directly flip to pilot mode).
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('spectator'); // still spectating
    expect(screen.getByTestId('pilot-menu-ship-ship-1')).toBeInTheDocument();
    expect(screen.queryByTestId('pilot-menu-ship-ship-2')).toBeNull(); // other player's hull excluded

    fireEvent.click(screen.getByTestId('pilot-menu-ship-ship-1'));
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
  });

  it('Pilot while spectating with NO own ships shows the "No ships to pilot" placeholder', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    setGameClient(fakeClient({ localPlayerId: 'p1', lingeringShips: new Map() }));
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(screen.getByTestId('pilot-menu-empty')).toBeInTheDocument();
    expect(sendPilotShip).not.toHaveBeenCalled();
  });
});
