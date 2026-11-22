/**
 * The ALWAYS-VISIBLE mode switch: Fly / Command / Build (RTS slice 10; Build
 * is the third mode, owner 2026-11-20). Locks:
 *   - renders three joined buttons in-game (Fly, Command, Build), null
 *     otherwise; aria-pressed reflects the mode;
 *   - Build enters Build mode; in Build, Command / Fly are the only way out;
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
import { resetBuildModeView, stepBuildModeView } from '../structures/buildModeView.js';

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

describe('PilotSpectatorToggle — Fly / Command / Build', () => {
  beforeEach(() => {
    resetBuildModeView();
    // In the sector and controllable (the curtain is down: `loadingCosmeticOnly`
    // short-circuits the readiness gates; the loading test below clears it).
    useUIStore.setState({ phase: 'game', loadingCosmeticOnly: true, pendingCommandStart: false, pilotMode: 'pilot', buildMode: false, placementKind: null, isDead: false, selection: { ids: [], focusId: null, focusKind: null } });
    vi.mocked(sendPilotShip).mockReset();
    vi.mocked(sendCommand).mockReset();
  });
  afterEach(() => setGameClient(null));

  it('renders three joined buttons, Fly, Command and Build in that order, while phase === "game"', () => {
    render(<PilotSpectatorToggle />);
    const group = screen.getByTestId('pilot-spectator-toggle');
    const ids = Array.from(group.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['pilot-toggle', 'spectator-toggle', 'build-toggle']);
    expect(screen.getByTestId('pilot-toggle')).toHaveTextContent('Fly');
    expect(screen.getByTestId('spectator-toggle')).toHaveTextContent('Command');
    expect(screen.getByTestId('build-toggle')).toHaveTextContent('Build');
  });

  it('Build enters Build mode from Fly (the switch shows it pressed)', () => {
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('build-toggle'));
    expect(useUIStore.getState().buildMode).toBe(true);
    expect(screen.getByTestId('pilot-spectator-toggle')).toHaveAttribute('data-value', 'build');
    expect(screen.getByTestId('build-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pilot-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('in Build, Command leaves to Command view (ship stays AI-flown, ghost dropped)', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true, placementKind: 'turret' });
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('spectator-toggle'));
    expect(useUIStore.getState().buildMode).toBe(false);
    expect(useUIStore.getState().placementKind).toBeNull();
    expect(screen.getByTestId('pilot-spectator-toggle')).toHaveAttribute('data-value', 'command');
    expect(sendCommand).not.toHaveBeenCalled();
    expect(sendPilotShip).not.toHaveBeenCalled();
  });

  it('in Build entered from Fly, Fly takes back the ship you were flying', () => {
    const cam = { glideCameraTo: vi.fn() };
    useUIStore.getState().setBuildMode(true);
    stepBuildModeView(true, { viewX: 0, viewY: 0, viewHalf: 400 }, 'ship-1', cam, 800, 400);
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(sendPilotShip).toHaveBeenCalledWith('ship-1');
    expect(useUIStore.getState().buildMode).toBe(false);
  });

  it('in Build entered from Command, Fly opens the ship menu', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true });
    ownFleet();
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(useUIStore.getState().buildMode).toBe(false);
    expect(screen.getByTestId('pilot-menu-ship-ship-1')).toBeInTheDocument();
  });

  it('renders nothing when phase !== "game"', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<PilotSpectatorToggle />);
    expect(screen.queryByTestId('pilot-spectator-toggle')).toBeNull();
  });

  it('renders nothing while the sector is still loading (owner smoke: the Helm showed over the loading screen)', () => {
    useUIStore.setState({ loadingCosmeticOnly: false, connectionStatus: 'connecting', firstSnapshotApplied: false, arrivalAcked: false });
    render(<PilotSpectatorToggle />);
    expect(screen.queryByTestId('pilot-spectator-toggle')).toBeNull();
  });

  it('a join that lands in Command view shows Command before the server flip (owner smoke: showed Fly, arrived in Command)', () => {
    useUIStore.getState().setPendingCommandStart(true);
    render(<PilotSpectatorToggle />);
    expect(useUIStore.getState().pilotMode).toBe('pilot'); // the server flip has not landed yet
    expect(screen.getByTestId('pilot-spectator-toggle')).toHaveAttribute('data-value', 'command');
    expect(screen.getByTestId('spectator-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('pilot-toggle')).toHaveAttribute('aria-pressed', 'false');
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
    expect(screen.getByTestId('pilot-spectator-toggle')).toHaveAttribute('data-value', 'command');
  });

  it('Fly with ONE own ship selected takes that ship at once (no menu)', () => {
    useUIStore.setState({ pilotMode: 'spectator', selection: { ids: ['ship-3'], focusId: null, focusKind: null } });
    ownFleet();
    render(<PilotSpectatorToggle />);
    fireEvent.click(screen.getByTestId('pilot-toggle'));
    expect(sendPilotShip).toHaveBeenCalledWith('ship-3');
    expect(screen.queryByTestId('pilot-menu-ship-ship-1')).toBeNull();
  });

  it('Fly with a foreign ship selected falls back to the menu (never flies it)', () => {
    useUIStore.setState({ pilotMode: 'spectator', selection: { ids: ['ship-2'], focusId: null, focusKind: null } });
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
