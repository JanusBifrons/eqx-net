/**
 * RTS command layer slice 14 — the fleet panel (desktop) and strip (compact).
 * Locks: shown with a selection, hidden without one,
 * shared vs mixed mode/stance, button enabled states, commands fire with the
 * selected ids, "+N more" capping, plain-language rows, the strip's order mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { FleetPanel, FLEET_PANEL_MAX_ROWS } from './FleetPanel.js';
import { FleetStrip } from './FleetStrip.js';
import { applyFleetStatus, resetFleetStatus, FLEET_STATUS_POLL_MS, type FleetStatusUpdate } from '../fleet/fleetStatus.js';
import { resetFleetCommands, setFleetCommands, type FleetCommands } from '../fleet/fleetCommands.js';
import { getGameClient, setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, ...over,
});

function getGameClientMirrorShips(): Map<string, Record<string, unknown>> {
  return (getGameClient() as unknown as { mirror: { ships: Map<string, Record<string, unknown>> } }).mirror.ships;
}

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
  useUIStore.setState({ phase: 'game', pilotMode: 'spectator', selection: { ids: [], focusId: null, focusKind: null }, placementKind: null, fleetPick: null });
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
  it('hidden with no selection, shown with one', () => {
    render(<FleetPanel />);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();

    act(() => useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } }));
    expect(screen.getByTestId('fleet-panel')).toHaveTextContent('2 ships selected');

    act(() => useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } }));
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
  });

  it('hidden outside command view and on a compact screen', () => {
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null }, pilotMode: 'pilot' });
    const { unmount } = render(<FleetPanel />);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    unmount();
    useUIStore.setState({ pilotMode: 'spectator' });
    setCompact(true);
    render(<FleetPanel />);
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
  });

  it('button enabled states follow the selection size and squads', () => {
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null } });
    const { unmount } = render(<FleetPanel />);
    expect(screen.getByTestId('fleet-panel')).toHaveTextContent('1 ship selected');
    expect(screen.getByTestId('fleet-take-controls')).toBeEnabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeDisabled();
    expect(screen.getByTestId('fleet-stop')).toBeEnabled();
    expect(screen.queryByTestId('fleet-disband-squad')).toBeNull();
    unmount();

    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
    render(<FleetPanel />);
    expect(screen.getByTestId('fleet-take-controls')).toBeDisabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeEnabled();
    expect(screen.getByTestId('fleet-disband-squad')).toBeEnabled();
  });

  it('commands fire with the selected ids (prop overrides and the plug-in seam)', () => {
    const cmds = mockCommands();
    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
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
    useUIStore.setState({ selection: { ids: ['b'], focusId: null, focusKind: null } });
    render(<FleetPanel />);
    fireEvent.click(screen.getByTestId('fleet-take-controls'));
    expect(take).toHaveBeenCalledWith('b');
  });

  it('shows the shared mode/stance, or "mixed" with none pressed', () => {
    applyFleetStatus([row('a', { mode: 'hunt', stance: 'aggressive' }), row('b', { mode: 'patrol', stance: 'aggressive' })]);
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
    render(<FleetPanel />);
    expect(screen.getByTestId('fleet-stance-aggressive')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('fleet-stance-defensive')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('fleet-stance-mixed')).toBeNull();
    expect(screen.getByTestId('fleet-mode-mixed')).toBeInTheDocument();
    expect(screen.getByTestId('fleet-mode-hunt')).toHaveAttribute('aria-pressed', 'false');
  });

  it('rows read in plain language with names (no ids) and update on the status poll', () => {
    vi.useFakeTimers();
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
    render(<FleetPanel />);
    const rows = screen.getAllByTestId('fleet-ship-row');
    expect(rows[0]).toHaveTextContent('Fighter');
    expect(rows[0]).toHaveTextContent('No report yet');
    expect(rows[0]!.textContent).not.toContain('a--');

    // Hull is the room-state health on the mirror ship entry (RTS Part A),
    // not a status-row field.
    const ships = (getGameClientMirrorShips());
    Object.assign(ships.get('a')!, { health: 80, maxHealth: 100 });
    Object.assign(ships.get('b')!, { health: 40, maxHealth: 200 });
    applyFleetStatus([
      row('a', { activity: 'chasing', targetId: '42' }),
      row('b', { activity: 'retreating' }),
    ]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const after = screen.getAllByTestId('fleet-ship-row');
    expect(after[0]).toHaveTextContent('Chasing Drone');
    expect(after[0]).toHaveTextContent('80%');
    expect(after[1]).toHaveTextContent('Scout');
    expect(after[1]).toHaveTextContent('Retreating – hull 20%');

    // Shield next to hull; a retreat with the hull whole says shields down.
    Object.assign(ships.get('a')!, { health: 100 });
    Object.assign(ships.get('b')!, { health: 200 });
    applyFleetStatus([
      row('a', { activity: 'attacking', shieldPct: 40 }),
      row('b', { activity: 'retreating', shieldPct: 0 }),
    ]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const third = screen.getAllByTestId('fleet-ship-row');
    expect(third[0]).toHaveTextContent('Shield 40% · Hull 100%');
    expect(third[1]).toHaveTextContent('Retreating – shields down');

    // Hull damage alone (no status change) still reaches the row on the poll.
    Object.assign(ships.get('a')!, { health: 55 });
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    expect(screen.getAllByTestId('fleet-ship-row')[0]).toHaveTextContent('Hull 55%');
  });

  it(`caps the list at ${FLEET_PANEL_MAX_ROWS} rows then "+N more"`, () => {
    const ids = Array.from({ length: FLEET_PANEL_MAX_ROWS + 3 }, (_, i) => `s${i}`);
    useUIStore.setState({ selection: { ids: ids, focusId: null, focusKind: null } });
    render(<FleetPanel />);
    expect(screen.getAllByTestId('fleet-ship-row')).toHaveLength(FLEET_PANEL_MAX_ROWS);
    expect(screen.getByTestId('fleet-more')).toHaveTextContent('+3 more');
  });
});

describe('FleetStrip (compact)', () => {
  it('shows only on a compact screen with a selection in command view', () => {
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null } });
    const { unmount } = render(<FleetStrip />);
    expect(screen.queryByTestId('fleet-strip')).toBeNull(); // not compact
    unmount();
    setCompact(true);
    render(<><FleetStrip /><FleetPanel /></>);
    expect(screen.getByTestId('fleet-strip')).toHaveTextContent('1 ship');
    expect(screen.queryByTestId('fleet-panel')).toBeNull();
    act(() => useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } }));
    expect(screen.queryByTestId('fleet-strip')).toBeNull();
  });

  it('selects send mode / stance, Stop fires, mixed reads "Mixed"', () => {
    setCompact(true);
    const cmds = mockCommands();
    applyFleetStatus([row('a', { mode: 'hunt' }), row('b', { mode: 'defend' })]);
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null } });
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

  it('has no Move / Attack tap-order toggle (tap rule T3: Move is on the left strip)', () => {
    setCompact(true);
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null } });
    render(<FleetStrip />);
    expect(screen.getByTestId('fleet-strip')).toBeTruthy();
    expect(screen.queryByTestId('fleet-order-move')).toBeNull();
    expect(screen.queryByTestId('fleet-order-attack')).toBeNull();
  });

  it('patrol / escort / retreat in the select start a map pick instead of sending (slice 14b)', () => {
    setCompact(true);
    const cmds = mockCommands();
    useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null }, rightPanel: 'fleet' });
    render(<FleetStrip commands={cmds} />);
    fireEvent.change(screen.getByTestId('fleet-strip-mode'), { target: { value: 'escort' } });
    expect(cmds.setMode).not.toHaveBeenCalled();
    expect(useUIStore.getState().fleetPick?.kind).toBe('escort');
    expect(useUIStore.getState().rightPanel, 'the pick needs the map: its tools are on the left strip').toBeNull();
  });
});

describe('fleet map picks (slice 14b)', () => {
  it('Patrol / Escort / Retreat start a map pick and close the panel (tools on the left strip, U3-3)', () => {
    const cmds = mockCommands();
    for (const m of ['patrol', 'escort', 'retreat'] as const) {
      useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null }, fleetPick: null, rightPanel: 'fleet' });
      const { unmount } = render(<FleetPanel commands={cmds} />);
      fireEvent.click(screen.getByTestId(`fleet-mode-${m}`));
      expect(useUIStore.getState().fleetPick).toEqual({ kind: m, points: 0, doneSeq: 0, undoSeq: 0 });
      expect(useUIStore.getState().rightPanel).toBeNull();
      unmount();
    }
    expect(cmds.setMode, 'the pick sends later, never the panel button').not.toHaveBeenCalled();
  });

  it('Defend and Hunt still send at once', () => {
    const cmds = mockCommands();
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null } });
    render(<FleetPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-defend'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a'], 'defend');
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('an emptied selection ends the pick', () => {
    useUIStore.setState({ selection: { ids: ['a'], focusId: null, focusKind: null } });
    useUIStore.getState().setFleetPick('patrol');
    useUIStore.getState().setSelection([], null, null);
    expect(useUIStore.getState().fleetPick).toBeNull();
  });
});

describe('Command speed lives in the selection panel, off the play area', () => {
  // The speed telegraph used to float in the top-centre slot, over the map,
  // where a right-click move order on that spot hit the bar instead of the
  // canvas. It now rides the fleet panel / strip, which already own the
  // bottom edge while ships are selected.
  const select = (): void => act(() => useUIStore.setState({
    travelling: true, commandSpeed: 3, selection: { ids: ['a', 'b'], focusId: null, focusKind: null },
  }));

  it('the desktop fleet panel carries the speed telegraph', () => {
    render(<FleetPanel />);
    select();
    const panel = screen.getByTestId('fleet-panel');
    expect(panel.querySelector('[data-testid="helm-panel"]')).not.toBeNull();
  });

  it('the compact fleet strip carries the speed telegraph', () => {
    setCompact(true);
    render(<FleetStrip />);
    select();
    const strip = screen.getByTestId('fleet-strip');
    expect(strip.querySelector('[data-testid="helm-panel"]')).not.toBeNull();
  });
});
