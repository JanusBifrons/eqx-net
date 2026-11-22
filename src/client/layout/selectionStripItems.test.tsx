/**
 * UI plan U3-1: the selection's quick actions on the left strip. Icons only
 * (no text), every action through the existing handler, and an action that
 * can't work is hidden, never shown and then refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUIStore } from '../state/store';
import type { PanelData } from '../components/selectionPanelData';

const lockSelected = vi.fn();
const cancelLock = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: { localPlayerId: 'me' }, lockSelected, cancelLock, getRoom: () => null }),
}));
const sendPilotShip = vi.fn();
vi.mock('../ships/shipActionsClient', () => ({ sendPilotShip: (id: string) => sendPilotShip(id) }));

import { useSelectionStripItems } from './selectionStripItems';

function Harness({ data, fleetLock = null }: { data: PanelData | null; fleetLock?: (() => void) | null }): JSX.Element {
  const { items, loot } = useSelectionStripItems(data, fleetLock);
  return <div data-testid="strip">{items}{loot}</div>;
}

function select(focusId: string, focusKind: 'ship' | 'structure' | 'pod' | 'lingering' | 'drone'): void {
  useUIStore.setState({
    selection: { ids: [], focusId, focusKind },
    activeGroupId: 'primary',
    fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
  });
}

beforeEach(() => { lockSelected.mockReset(); cancelLock.mockReset(); sendPilotShip.mockReset(); });
afterEach(() => cleanup());

const shown = (): string[] =>
  Array.from(screen.getByTestId('strip').querySelectorAll('button')).map((b) => b.getAttribute('data-testid') ?? '');

describe('selection strip quick actions (U3-1)', () => {
  it("another player's ship: Target and Cargo, icons only; Target asks for the lock and carries data-state", () => {
    select('p2', 'ship');
    render(<Harness data={{ name: 'Fighter', hpPct: 90, shieldPct: 50, cargoShip: 'p2', bountyTarget: 'p2' }} />);
    expect(shown()).toEqual(['fc-target', 'cargo-open-toggle']);
    expect(screen.getByTestId('strip').textContent).toBe('');
    const t = screen.getByTestId('fc-target');
    expect(t.getAttribute('data-state')).toBe('lock');
    expect(t.getAttribute('aria-label')).toBe('Lock · Primary');
    fireEvent.click(t);
    expect(lockSelected).toHaveBeenCalledOnce();
  });

  it('tap rule T2: with a fleet Lock, ONE Lock replaces the personal Target; a tap runs the fleet Lock', () => {
    select('p2', 'ship');
    const fleetLock = vi.fn();
    render(<Harness data={{ name: 'Fighter', hpPct: 90, shieldPct: 50, cargoShip: 'p2' }} fleetLock={fleetLock} />);
    expect(shown()).toEqual(['left-strip-lock', 'cargo-open-toggle']);
    fireEvent.click(screen.getByTestId('left-strip-lock'));
    expect(fleetLock).toHaveBeenCalledOnce();
    expect(lockSelected).not.toHaveBeenCalled();
  });

  it('own parked hull: Pilot (no Target); a tap sends the existing pilot request', () => {
    select('hull-1', 'lingering');
    render(<Harness data={{ name: 'My hull', hpPct: 100, shieldPct: null, cargoShip: 'hull-1', pilotShipId: 'hull-1' }} />);
    expect(shown()).toEqual(['cargo-open-toggle', 'ship-action-pilot']);
    fireEvent.click(screen.getByTestId('ship-action-pilot'));
    expect(sendPilotShip).toHaveBeenCalledWith('hull-1');
  });

  it('own building with no hold: nothing (its actions live in Details)', () => {
    select('swarm-5', 'structure');
    render(<Harness data={{ name: 'Turret', hpPct: 100, shieldPct: null, isOwn: true, entityId: 5 }} />);
    expect(shown()).toEqual([]);
  });

  it('a pod out of reach shows no Open; in reach it opens the loot window, Close shuts it', async () => {
    select('swarm-4', 'pod');
    const { rerender } = render(<Harness data={{ name: 'Cargo pod', hpPct: 0, shieldPct: null, noHull: true, entityId: 4, podOpen: false }} />);
    expect(screen.queryByTestId('pod-open')).toBeNull();
    rerender(<Harness data={{ name: 'Cargo pod', hpPct: 0, shieldPct: null, noHull: true, entityId: 4, podOpen: true, infoLine: 'Huge' }} />);
    expect(screen.queryByTestId('loot-window')).toBeNull();
    fireEvent.click(screen.getByTestId('pod-open'));
    expect(screen.getByTestId('loot-window')).toBeTruthy();
    fireEvent.click(screen.getByTestId('loot-window-close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a building lock that cannot progress reads blocked (danger) and a tap cancels it', () => {
    useUIStore.setState({
      selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' },
      activeGroupId: 'primary',
      fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: [{ target: 's:9', stage: 1, blocked: true }] }],
    });
    render(<Harness data={{ name: 'Depot', hpPct: 100, shieldPct: null, entityId: 9 }} />);
    const t = screen.getByTestId('fc-target');
    expect(t.getAttribute('data-state')).toBe('blocked');
    expect(t.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(t);
    expect(cancelLock).toHaveBeenCalledWith('primary', 's:9');
  });
});
