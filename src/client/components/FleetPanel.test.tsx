/**
 * RTS command layer slice 14 — the fleet panel (desktop) and strip (compact).
 * Locks: the show/hide swap with the build palette (palette stays mounted),
 * shared vs mixed mode/stance, button enabled states, commands fire with the
 * selected ids, "+N more" capping, plain-language rows, the strip's order mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { FleetPanel, FLEET_PANEL_MAX_ROWS } from './FleetPanel.js';
import { FleetStrip } from './FleetStrip.js';
import { BottomControlPanel } from './BottomControlPanel.js';
import { applyFleetStatus, resetFleetStatus, FLEET_STATUS_POLL_MS, type FleetStatusUpdate } from '../fleet/fleetStatus.js';
import { resetFleetCommands, setFleetCommands, type FleetCommands } from '../fleet/fleetCommands.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, hullPct: 100, ...over,
});

function mockCommands(): { [K in keyof FleetCommands]: ReturnType<typeof vi.fn> } {
  return {
    setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), formSquad: vi.fn(), disbandSquad: vi.fn(), takeControls: vi.fn(),
  };
}

function setCompact(compact: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: compact,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  resetFleetStatus();
  resetFleetCommands();
  setCompact(false);
  useUIStore.setState({ phase: 'game', pilotMode: 'spectator', fleetSelection: [], fleetOrderMode: 'move', placementKind: null, fleetPick: null });
  setGameClient({
    getRoom: () => null,
    mirror: {
      ships: new Map([
        ['a', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter', ownerPlayerId: 'me', isActive: false }],
        ['b', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'scout', ownerPlayerId: 'me', isActive: false }],
      ]),
      swarm: new Map([[42, { kind: 1, shipKind: undefined }]]),
    },
  } as unknown as ColyseusGameClient);
});

afterEach(() => {
  setGameClient(null);
  vi.useRealTimers();
  // @ts-expect-error test cleanup of the jsdom stub
  delete window.matchMedia;
});

describe('FleetPanel (desktop)', () => {
  it('swaps with the build palette: hidden with no selection, shown with one; palette stays mounted', () => {
    render(<><BottomControlPanel /><FleetPanel /></>);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    const palette = screen.getByTestId('bottom-control-panel');
    expect(palette).toHaveAttribute('data-panel-mode', 'build');

    act(() => useUIStore.setState({ fleetSelection: ['a', 'b'] }));
    expect(screen.getByTestId('fleet-panel')).toHaveTextContent('2 ships selected');
    expect(screen.getByTestId('bottom-control-panel')).toBe(palette);
    expect(palette).toHaveAttribute('data-panel-mode', 'hidden');

    act(() => useUIStore.setState({ fleetSelection: [] }));
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    expect(palette).toHaveAttribute('data-panel-mode', 'build');
  });

  it('hidden outside command view and on a compact screen', () => {
    useUIStore.setState({ fleetSelection: ['a'], pilotMode: 'pilot' });
    const { unmount } = render(<FleetPanel />);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    unmount();
    useUIStore.setState({ pilotMode: 'spectator' });
    setCompact(true);
    render(<FleetPanel />);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
  });

  it('button enabled states follow the selection size and squads', () => {
    useUIStore.setState({ fleetSelection: ['a'] });
    const { unmount } = render(<FleetPanel />);
    expect(screen.getByTestId('fleet-panel')).toHaveTextContent('1 ship selected');
    expect(screen.getByTestId('fleet-take-controls')).toBeEnabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeDisabled();
    expect(screen.getByTestId('fleet-stop')).toBeEnabled();
    expect(screen.queryByTestId('fleet-disband-squad')).toBeNull();
    unmount();

    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel />);
    expect(screen.getByTestId('fleet-take-controls')).toBeDisabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeEnabled();
    expect(screen.getByTestId('fleet-disband-squad')).toBeEnabled();
  });

  it('commands fire with the selected ids (prop overrides and the plug-in seam)', () => {
    const cmds = mockCommands();
    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-hunt'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a', 'b'], 'hunt');
    fireEvent.click(screen.getByTestId('fleet-stance-holdFire'));
    expect(cmds.setStance).toHaveBeenCalledWith(['a', 'b'], 'holdFire');
    fireEvent.click(screen.getByTestId('fleet-stop'));
    expect(cmds.stop).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByTestId('fleet-form-squad'));
    expect(cmds.formSquad).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByTestId('fleet-disband-squad'));
    expect(cmds.disbandSquad).toHaveBeenCalledWith('sq');
  });

  it('take controls goes through the plugged-in seam', () => {
    const take = vi.fn();
    setFleetCommands({ takeControls: take });
    useUIStore.setState({ fleetSelection: ['b'] });
    render(<FleetPanel />);
    fireEvent.click(screen.getByTestId('fleet-take-controls'));
    expect(take).toHaveBeenCalledWith('b');
  });

  it('shows the shared mode/stance, or "mixed" with none pressed', () => {
    applyFleetStatus([row('a', { mode: 'hunt', stance: 'aggressive' }), row('b', { mode: 'patrol', stance: 'aggressive' })]);
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel />);
    expect(screen.getByTestId('fleet-stance-aggressive')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('fleet-stance-defensive')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('fleet-stance-mixed')).toBeNull();
    expect(screen.getByTestId('fleet-mode-mixed')).toBeInTheDocument();
    expect(screen.getByTestId('fleet-mode-hunt')).toHaveAttribute('aria-pressed', 'false');
  });

  it('rows read in plain language with names (no ids) and update on the status poll', () => {
    vi.useFakeTimers();
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel />);
    const rows = screen.getAllByTestId('fleet-ship-row');
    expect(rows[0]).toHaveTextContent('Fighter');
    expect(rows[0]).toHaveTextContent('No report yet');
    expect(rows[0]!.textContent).not.toContain('a--');

    applyFleetStatus([
      row('a', { activity: 'chasing', targetId: '42', hullPct: 80 }),
      row('b', { activity: 'retreating', hullPct: 20 }),
    ]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const after = screen.getAllByTestId('fleet-ship-row');
    expect(after[0]).toHaveTextContent('Chasing Drone');
    expect(after[0]).toHaveTextContent('80%');
    expect(after[1]).toHaveTextContent('Scout');
    expect(after[1]).toHaveTextContent('Retreating – hull 20%');

    // Shield next to hull, and a morale retreat says why.
    applyFleetStatus([
      row('a', { activity: 'attacking', hullPct: 100, shieldPct: 40 }),
      row('b', { activity: 'retreating', hullPct: 100, shieldPct: 0, moraleOutcome: 'fallBack' }),
    ]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const third = screen.getAllByTestId('fleet-ship-row');
    expect(third[0]).toHaveTextContent('Shield 40% · Hull 100%');
    expect(third[1]).toHaveTextContent('Falling back – shields down');
  });

  it(`caps the list at ${FLEET_PANEL_MAX_ROWS} rows then "+N more"`, () => {
    const ids = Array.from({ length: FLEET_PANEL_MAX_ROWS + 3 }, (_, i) => `s${i}`);
    useUIStore.setState({ fleetSelection: ids });
    render(<FleetPanel />);
    expect(screen.getAllByTestId('fleet-ship-row')).toHaveLength(FLEET_PANEL_MAX_ROWS);
    expect(screen.getByTestId('fleet-more')).toHaveTextContent('+3 more');
  });
});

describe('FleetStrip (compact)', () => {
  it('shows only on a compact screen with a selection in command view', () => {
    useUIStore.setState({ fleetSelection: ['a'] });
    const { unmount } = render(<FleetStrip />);
    expect(screen.queryByTestId('fleet-strip')).toBeNull(); // not compact
    unmount();
    setCompact(true);
    render(<><FleetStrip /><FleetPanel /></>);
    expect(screen.getByTestId('fleet-strip')).toHaveTextContent('1 ship');
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    act(() => useUIStore.setState({ fleetSelection: [] }));
    expect(screen.queryByTestId('fleet-strip')).toBeNull();
  });

  it('selects send mode / stance, Stop fires, mixed reads "Mixed"', () => {
    setCompact(true);
    const cmds = mockCommands();
    applyFleetStatus([row('a', { mode: 'hunt' }), row('b', { mode: 'defend' })]);
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetStrip commands={cmds} />);
    const mode = screen.getByTestId('fleet-strip-mode') as HTMLSelectElement;
    expect(mode.value).toBe('');
    expect(mode).toHaveTextContent('Mixed');
    fireEvent.change(mode, { target: { value: 'defend' } });
    expect(cmds.setMode).toHaveBeenCalledWith(['a', 'b'], 'defend');
    const stance = screen.getByTestId('fleet-strip-stance') as HTMLSelectElement;
    expect(stance.value).toBe('defensive');
    fireEvent.change(stance, { target: { value: 'holdFire' } });
    expect(cmds.setStance).toHaveBeenCalledWith(['a', 'b'], 'holdFire');
    fireEvent.click(screen.getByTestId('fleet-stop'));
    expect(cmds.stop).toHaveBeenCalledWith(['a', 'b']);
  });

  it('the Move / Attack toggle sets the discrete fleetOrderMode', () => {
    setCompact(true);
    useUIStore.setState({ fleetSelection: ['a'] });
    render(<FleetStrip />);
    expect(screen.getByTestId('fleet-order-move')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('fleet-order-attack'));
    expect(useUIStore.getState().fleetOrderMode).toBe('attack');
    expect(screen.getByTestId('fleet-order-attack')).toHaveAttribute('aria-pressed', 'true');
    // Clicking the pressed one keeps it (exclusive group never goes empty).
    fireEvent.click(screen.getByTestId('fleet-order-attack'));
    expect(useUIStore.getState().fleetOrderMode).toBe('attack');
  });

  it('patrol / escort / retreat in the select start a map pick instead of sending (slice 14b)', () => {
    setCompact(true);
    const cmds = mockCommands();
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetStrip commands={cmds} />);
    fireEvent.change(screen.getByTestId('fleet-strip-mode'), { target: { value: 'escort' } });
    expect(cmds.setMode).not.toHaveBeenCalled();
    expect(useUIStore.getState().fleetPick?.kind).toBe('escort');
    expect(screen.getByTestId('fleet-pick-hint').textContent).toMatch(/your other ships to escort/);
    expect(screen.queryByTestId('fleet-strip-mode')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-pick-cancel'));
    expect(useUIStore.getState().fleetPick).toBeNull();
    expect(screen.getByTestId('fleet-strip-mode')).toBeInTheDocument();
  });
});

describe('fleet map picks (slice 14b)', () => {
  it('Patrol enters a route pick; Done is disabled under 2 points; Done bumps doneSeq', () => {
    const cmds = mockCommands();
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-patrol'));
    expect(cmds.setMode).not.toHaveBeenCalled();
    expect(useUIStore.getState().fleetPick).toEqual({ kind: 'patrol', points: 0, doneSeq: 0 });
    expect(screen.getByTestId('fleet-pick-hint')).toHaveTextContent('Click points for the patrol route, then Done');
    expect(screen.queryByTestId('fleet-mode-hunt'), 'mode buttons give way to the pick bar').toBeNull();
    const done = screen.getByTestId('fleet-pick-done');
    expect(done).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(1));
    expect(screen.getByTestId('fleet-pick-done')).toBeDisabled();
    act(() => useUIStore.getState().setFleetPickPoints(2));
    expect(screen.getByTestId('fleet-pick-done')).toBeEnabled();
    fireEvent.click(screen.getByTestId('fleet-pick-done'));
    expect(useUIStore.getState().fleetPick?.doneSeq).toBe(1);
    expect(cmds.setMode, 'the renderer sends the route, not the panel').not.toHaveBeenCalled();
  });

  it('Cancel leaves the pick and brings the mode buttons back', () => {
    useUIStore.setState({ fleetSelection: ['a'] });
    render(<FleetPanel commands={mockCommands()} />);
    fireEvent.click(screen.getByTestId('fleet-mode-escort'));
    expect(screen.getByTestId('fleet-pick')).toHaveAttribute('data-fleet-pick', 'escort');
    expect(screen.queryByTestId('fleet-pick-done')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-pick-cancel'));
    expect(useUIStore.getState().fleetPick).toBeNull();
    expect(screen.getByTestId('fleet-mode-escort')).toBeInTheDocument();
  });

  it('Retreat: "Back to post" sends retreat with no point and ends the pick', () => {
    const cmds = mockCommands();
    useUIStore.setState({ fleetSelection: ['a', 'b'] });
    render(<FleetPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-retreat'));
    expect(screen.getByTestId('fleet-pick-hint')).toHaveTextContent('Click where to retreat to');
    fireEvent.click(screen.getByTestId('fleet-pick-post'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a', 'b'], 'retreat');
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('Defend and Hunt still send at once', () => {
    const cmds = mockCommands();
    useUIStore.setState({ fleetSelection: ['a'] });
    render(<FleetPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-defend'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a'], 'defend');
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('an emptied selection ends the pick', () => {
    useUIStore.setState({ fleetSelection: ['a'] });
    useUIStore.getState().setFleetPick('patrol');
    useUIStore.getState().setFleetSelection([]);
    expect(useUIStore.getState().fleetPick).toBeNull();
  });
});
