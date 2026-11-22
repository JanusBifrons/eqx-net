/**
 * UI plan U3-5: the Orders panel (was FleetPanel / FleetStrip / HelmPanel).
 * Locks: shown with a selection in Command, empty without one, shared vs
 * mixed order/stance, picks are drafts until Apply (amber, Apply on), Apply
 * sends only what changed and folds the panel, Patrol / Escort / Retreat start
 * a map pick, Stop / squad / take controls send at once, the speed telegraph
 * (Command only) sets the Command speed and re-paces the selection, "+N more"
 * capping, plain-language rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HELM_SPEED_FRACTION } from '@core/helm/helm';
import { useUIStore } from '../state/store.js';
import { OrdersPanel, ORDERS_MAX_ROWS } from './OrdersPanel.js';
import { applyFleetStatus, resetFleetStatus, FLEET_STATUS_POLL_MS, type FleetStatusUpdate } from '../fleet/fleetStatus.js';
import { resetFleetCommands, setFleetCommands, type FleetCommands } from '../fleet/fleetCommands.js';
import { getGameClient, setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, ...over,
});

function mirrorShips(): Map<string, Record<string, unknown>> {
  return (getGameClient() as unknown as { mirror: { ships: Map<string, Record<string, unknown>> } }).mirror.ships;
}

function mockCommands(): { [K in keyof FleetCommands]: ReturnType<typeof vi.fn> } {
  return {
    setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), formSquad: vi.fn(), disbandSquad: vi.fn(), takeControls: vi.fn(), setSpeed: vi.fn(),
  };
}

const select = (ids: string[]): void => { useUIStore.setState({ selection: { ids, focusId: null, focusKind: null } }); };
const pressed = (id: string): string | null => screen.getByTestId(id).getAttribute('aria-pressed');

beforeEach(() => {
  resetFleetStatus();
  resetFleetCommands();
  useUIStore.setState({
    phase: 'game', pilotMode: 'spectator', buildMode: false, travelling: true, commandSpeed: 3, rightPanel: 'orders',
    selection: { ids: [], focusId: null, focusKind: null }, placementKind: null, fleetPick: null,
  });
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
  useUIStore.setState({ rightPanel: null, pilotMode: 'pilot', selection: { ids: [], focusId: null, focusKind: null } });
});

describe('OrdersPanel', () => {
  it('shows the orders with a selection, none without one', () => {
    render(<OrdersPanel />);
    expect(screen.queryByTestId('fleet-mode')).toBeNull();
    expect(screen.queryByTestId('eqx-panel-footer')).toBeNull();

    act(() => select(['a', 'b']));
    expect(screen.getByTestId('orders-panel')).toHaveTextContent('2 ships selected');
    expect(screen.getByTestId('orders-panel')).toHaveAttribute('data-fleet-count', '2');
    expect(screen.getByTestId('fleet-mode')).toBeTruthy();

    act(() => select([]));
    expect(screen.queryByTestId('fleet-mode')).toBeNull();
  });

  it('no orders outside Command view (Fly)', () => {
    select(['a']);
    useUIStore.setState({ pilotMode: 'pilot' });
    render(<OrdersPanel />);
    expect(screen.queryByTestId('fleet-mode')).toBeNull();
    expect(screen.queryByTestId('helm-speed')).toBeNull();
  });

  it('button enabled states follow the selection size and squads', () => {
    select(['a']);
    const { unmount } = render(<OrdersPanel />);
    expect(screen.getByTestId('orders-panel')).toHaveTextContent('1 ship selected');
    expect(screen.getByTestId('fleet-take-controls')).toBeEnabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeDisabled();
    expect(screen.getByTestId('fleet-stop')).toBeEnabled();
    expect(screen.queryByTestId('fleet-disband-squad')).toBeNull();
    unmount();

    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    select(['a', 'b']);
    render(<OrdersPanel />);
    expect(screen.getByTestId('fleet-take-controls')).toBeDisabled();
    expect(screen.getByTestId('fleet-form-squad')).toBeEnabled();
    expect(screen.getByTestId('fleet-disband-squad')).toBeEnabled();
  });

  it('Stop, squad and take controls send at once with the selected ids', () => {
    const cmds = mockCommands();
    applyFleetStatus([row('a', { squadId: 'sq' }), row('b', { squadId: 'sq' })]);
    select(['a', 'b']);
    render(<OrdersPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-stop'));
    expect(cmds.stop).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByTestId('fleet-form-squad'));
    expect(cmds.formSquad).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByTestId('fleet-disband-squad'));
    expect(cmds.disbandSquad).toHaveBeenCalledWith('sq');
    expect(useUIStore.getState().rightPanel, 'Stop keeps the panel open').toBe('orders');
  });

  it('take controls goes through the plugged-in seam', () => {
    const take = vi.fn();
    setFleetCommands({ takeControls: take });
    select(['b']);
    render(<OrdersPanel />);
    fireEvent.click(screen.getByTestId('fleet-take-controls'));
    expect(take).toHaveBeenCalledWith('b');
  });

  it('shows the shared order/stance, or "mixed" with none pressed', () => {
    applyFleetStatus([row('a', { mode: 'hunt', stance: 'aggressive' }), row('b', { mode: 'patrol', stance: 'aggressive' })]);
    select(['a', 'b']);
    render(<OrdersPanel />);
    expect(pressed('fleet-stance-aggressive')).toBe('true');
    expect(pressed('fleet-stance-defensive')).toBe('false');
    expect(screen.getByTestId('fleet-stance-section')).not.toHaveTextContent('mixed');
    expect(screen.getByTestId('fleet-mode-section')).toHaveTextContent('mixed');
    expect(pressed('fleet-mode-hunt')).toBe('false');
  });

  it('a pick is a draft (amber, Apply on); Apply sends only what changed and folds the panel', () => {
    const cmds = mockCommands();
    applyFleetStatus([row('a'), row('b')]);
    select(['a', 'b']);
    render(<OrdersPanel commands={cmds} />);
    expect(screen.getByTestId('eqx-panel-apply')).toBeDisabled();

    fireEvent.click(screen.getByTestId('fleet-mode-hunt'));
    fireEvent.click(screen.getByTestId('fleet-stance-holdFire'));
    expect(cmds.setMode).not.toHaveBeenCalled();
    expect(cmds.setStance).not.toHaveBeenCalled();
    expect(screen.getByTestId('fleet-mode')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('fleet-stance')).toHaveAttribute('data-changed', 'true');
    expect(screen.getByTestId('helm-speed')).not.toHaveAttribute('data-changed');
    expect(screen.getByTestId('eqx-panel-apply')).toBeEnabled();

    // Back to the applied value: no longer changed.
    fireEvent.click(screen.getByTestId('fleet-stance-defensive'));
    expect(screen.getByTestId('fleet-stance')).not.toHaveAttribute('data-changed');

    fireEvent.click(screen.getByTestId('eqx-panel-apply'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a', 'b'], 'hunt');
    expect(cmds.setStance).not.toHaveBeenCalled();
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('closing the panel drops unapplied picks', () => {
    const cmds = mockCommands();
    select(['a']);
    render(<OrdersPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-hunt'));
    act(() => { useUIStore.setState({ rightPanel: null }); });
    act(() => { useUIStore.setState({ rightPanel: 'orders' }); });
    expect(screen.getByTestId('eqx-panel-apply')).toBeDisabled();
    expect(cmds.setMode).not.toHaveBeenCalled();
  });

  it('rows read in plain language with names (no ids) and update on the status poll', () => {
    vi.useFakeTimers();
    select(['a', 'b']);
    render(<OrdersPanel />);
    const rows = screen.getAllByTestId('fleet-ship-row');
    expect(rows[0]).toHaveTextContent('Fighter');
    expect(rows[0]).toHaveTextContent('No report yet');
    expect(rows[0]).toHaveAttribute('data-ship-id', 'a');
    expect(rows[0]!.textContent).not.toContain('a--');

    const ships = mirrorShips();
    Object.assign(ships.get('a')!, { health: 80, maxHealth: 100 });
    Object.assign(ships.get('b')!, { health: 40, maxHealth: 200 });
    applyFleetStatus([row('a', { activity: 'chasing', targetId: '42' }), row('b', { activity: 'retreating' })]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const after = screen.getAllByTestId('fleet-ship-row');
    expect(after[0]).toHaveTextContent('Chasing Drone');
    expect(after[0]).toHaveTextContent('80%');
    expect(after[1]).toHaveTextContent('Scout');
    expect(after[1]).toHaveTextContent('Retreating – hull 20%');

    Object.assign(ships.get('a')!, { health: 100 });
    Object.assign(ships.get('b')!, { health: 200 });
    applyFleetStatus([row('a', { activity: 'attacking', shieldPct: 40 }), row('b', { activity: 'retreating', shieldPct: 0 })]);
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    const third = screen.getAllByTestId('fleet-ship-row');
    expect(third[0]).toHaveTextContent('Shield 40% · Hull 100%');
    expect(third[1]).toHaveTextContent('Retreating – shields down');

    Object.assign(ships.get('a')!, { health: 55 });
    act(() => { vi.advanceTimersByTime(FLEET_STATUS_POLL_MS + 10); });
    expect(screen.getAllByTestId('fleet-ship-row')[0]).toHaveTextContent('Hull 55%');
  });

  it(`caps the list at ${ORDERS_MAX_ROWS} rows then "+N more"`, () => {
    select(Array.from({ length: ORDERS_MAX_ROWS + 3 }, (_, i) => `s${i}`));
    render(<OrdersPanel />);
    expect(screen.getAllByTestId('fleet-ship-row')).toHaveLength(ORDERS_MAX_ROWS);
    expect(screen.getByTestId('fleet-more')).toHaveTextContent('+3 more');
  });

  it('has no Move / Attack tap-order toggle (tap rule T3: Move is on the left strip)', () => {
    select(['a']);
    render(<OrdersPanel />);
    expect(screen.queryByTestId('fleet-order-move')).toBeNull();
    expect(screen.queryByTestId('fleet-order-attack')).toBeNull();
  });
});

describe('fleet map picks (slice 14b)', () => {
  it('Patrol / Escort / Retreat start a map pick on Apply and close the panel (tools on the left strip)', () => {
    const cmds = mockCommands();
    for (const m of ['patrol', 'escort', 'retreat'] as const) {
      useUIStore.setState({ selection: { ids: ['a', 'b'], focusId: null, focusKind: null }, fleetPick: null, rightPanel: 'orders' });
      const { unmount } = render(<OrdersPanel commands={cmds} />);
      fireEvent.click(screen.getByTestId(`fleet-mode-${m}`));
      expect(useUIStore.getState().fleetPick).toBeNull();
      fireEvent.click(screen.getByTestId('eqx-panel-apply'));
      expect(useUIStore.getState().fleetPick).toEqual({ kind: m, points: 0, doneSeq: 0, undoSeq: 0 });
      expect(useUIStore.getState().rightPanel).toBeNull();
      unmount();
    }
    expect(cmds.setMode, 'the pick sends later, never the panel').not.toHaveBeenCalled();
  });

  it('Defend and Hunt send on Apply', () => {
    const cmds = mockCommands();
    applyFleetStatus([row('a', { mode: 'hunt' })]);
    select(['a']);
    render(<OrdersPanel commands={cmds} />);
    fireEvent.click(screen.getByTestId('fleet-mode-defend'));
    fireEvent.click(screen.getByTestId('eqx-panel-apply'));
    expect(cmds.setMode).toHaveBeenCalledWith(['a'], 'defend');
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('an emptied selection ends the pick', () => {
    select(['a']);
    useUIStore.getState().setFleetPick('patrol');
    useUIStore.getState().setSelection([], null, null);
    expect(useUIStore.getState().fleetPick).toBeNull();
  });
});

describe('Command speed (was HelmPanel): a Command control, never Fly or Build', () => {
  it('shows in Command with ships selected, on the current Command speed', () => {
    select(['a', 'b']);
    render(<OrdersPanel />);
    expect(screen.getByTestId('helm-speed')).toHaveAttribute('data-value', '3');
    expect(pressed('helm-speed-3')).toBe('true');
  });

  it('is hidden in Build', () => {
    select(['a', 'b']);
    useUIStore.setState({ buildMode: true });
    render(<OrdersPanel />);
    expect(screen.queryByTestId('helm-speed')).toBeNull();
  });

  it('Apply sets the Command speed and re-paces the selection', () => {
    const sent: { ids: readonly string[]; fraction: number }[] = [];
    setFleetCommands({ setSpeed: (ids, fraction) => { sent.push({ ids: [...ids], fraction }); } });
    select(['a', 'b']);
    render(<OrdersPanel />);
    fireEvent.click(screen.getByTestId('helm-speed-1'));
    expect(screen.getByTestId('helm-speed')).toHaveAttribute('data-changed', 'true');
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByTestId('eqx-panel-apply'));
    expect(useUIStore.getState().commandSpeed).toBe(1);
    expect(sent).toEqual([{ ids: ['a', 'b'], fraction: HELM_SPEED_FRACTION[1] }]);

    act(() => { useUIStore.setState({ rightPanel: 'orders' }); });
    fireEvent.click(screen.getByTestId('helm-speed-0'));
    fireEvent.click(screen.getByTestId('eqx-panel-apply'));
    expect(sent[1]).toEqual({ ids: ['a', 'b'], fraction: 0 });
  });
});
