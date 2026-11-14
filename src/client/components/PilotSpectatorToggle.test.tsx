/**
 * The ALWAYS-VISIBLE Command ⇄ Fly toggle (RTS slice 10; was Pilot ⇄ Spectate).
 * Locks:
 *   - renders both joined buttons in-game, null otherwise; aria-pressed reflects
 *     the mode; the labels are the plain "Command" / "Fly";
 *   - Command flips `pilotMode` to spectator and sends `command` (hands the
 *     ship back to its AI);
 *   - Fly in command view with exactly ONE own parked ship selected takes it at
 *     once (`sendPilotShip`), no menu;
 *   - Fly with no (or a foreign / several) selection opens the menu of OWN
 *     in-sector ships; picking one `sendPilotShip`s it; with none it shows
 *     "No ships to fly".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { sendCommand, sendPilotShip } from '../ships/shipActionsClient.js';
import { PilotSpectatorToggle } from './PilotSpectatorToggle.js';

vi.mock('../ships/shipActionsClient.js', () => ({ sendPilotShip: vi.fn(), sendCommand: vi.fn() }));

function fakeClient(mirror: Record<string, unknown>): ColyseusGameClient {
  return { mirror } as unknown as ColyseusGameClient;
}

function ownFleet(): void {
  setGameClient(
    fakeClient({
      localPlayerId: 'p1',
      ships: new Map<string, unknown>([
        ['ship-1', { ownerPlayerId: 'p1', kind: 'fighter', isActive: false }],
        ['ship-3', { ownerPlayerId: 'p1', kind: 'scout', isActive: false }],
        ['ship-2', { ownerPlayerId: 'other', kind: 'scout', isActive: false }], // NOT mine → excluded
      ]),
    }),
  );
}

describe('PilotSpectatorToggle — Command / Fly (RTS slice 10)', () => {
  beforeEach(() => {
    useUIStore.setState({ phase: 'game', pilotMode: 'pilot', isDead: false, fleetSelection: [] });
    vi.mocked(sendPilotShip).mockReset();
    vi.mocked(sendCommand).mockReset();
  });
  afterEach(() => setGameClient(null));

  it('renders both joined buttons, labelled Command and Fly, while phase === "game"', () => {
    render(<PilotSpectatorToggle />);
    expect(screen.getByTestId('pilot-spectator-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('spectator-toggle')).toHaveTextContent('Command');
    expect(screen.getByTestId('pilot-toggle')).toHaveTextContent('Fly');
  });

  it('renders nothing when phase !== "game"', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<PilotSpectatorToggle />);
    expect(screen.queryByTestId('pilot-spectator-toggle')).toBeNull();
  });

  it('Command enters command view and hands the ship back to the AI (sends command)', () => {
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('spectator-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('spectator');
    expect(useUIStore.getState().isDead).toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('reflects the active mode on the selected button (aria-pressed)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<PilotSpectatorToggle />);
    expect(screen.getByTestId('spectator-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pilot-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pilot-spectator-toggle')).toHaveAttribute('data-control-mode', 'command');
  });

  it('Fly with ONE own ship selected takes that ship at once (no menu)', () => {
    useUIStore.setState({ pilotMode: 'spectator', fleetSelection: ['ship-3'] });
    ownFleet();
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(sendPilotShip).toHaveBeenCalledWith('ship-3');
    expect(screen.queryByTestId('pilot-menu-ship-ship-1')).toBeNull();
  });

  it('Fly with a foreign ship selected falls back to the menu (never flies it)', () => {
    useUIStore.setState({ pilotMode: 'spectator', fleetSelection: ['ship-2'] });
    ownFleet();
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(sendPilotShip).not.toHaveBeenCalled();
    expect(screen.getByTestId('pilot-menu-ship-ship-1')).toBeInTheDocument();
  });

  it('Fly with no selection opens a menu of OWN ships; picking one sends pilot_ship', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    ownFleet();
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(useUIStore.getState().pilotMode).toBe('spectator'); // still commanding
    expect(screen.getByTestId('pilot-menu-ship-ship-1')).toBeInTheDocument();
    expect(screen.queryByTestId('pilot-menu-ship-ship-2')).toBeNull(); // other player's hull excluded

    fireEvent.click(screen.getByTestId('pilot-menu-ship-ship-1'));
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
  });

  it('Fly with NO own ships shows the "No ships to fly" placeholder', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    setGameClient(fakeClient({ localPlayerId: 'p1', ships: new Map() }));
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(screen.getByTestId('pilot-menu-empty')).toHaveTextContent('No ships to fly');
    expect(sendPilotShip).not.toHaveBeenCalled();
  });
});
