/**
 * Selection-HUD S8: the target do-hexes in the host. Own ships selected in
 * Command plus a tapped target that is not mine: Follow (dimmed, no order),
 * Move to (the move order to the target), Attack (the T2 Lock -> the
 * renderer's attackFocus), More (the target's Details), Clear (the renderer
 * keeps only the ships, back to the fleet set).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const sendFleetOrder = vi.fn();
vi.mock('../ships/shipActionsClient', async (orig) => ({
  ...(await orig<typeof import('../ships/shipActionsClient')>()),
  sendFleetOrder: (...a: unknown[]) => sendFleetOrder(...a),
}));
const client = {
  mirror: { localPlayerId: 'me', ships: new Map([['p2', { x: 120, y: -40, kind: 'fighter' }]]) },
};
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => client }));

import { useUIStore } from '../state/store';
import { resetFleetStatus } from '../fleet/fleetStatus';
import { LayoutProvider } from './LayoutProvider';
import { DoHexesHost } from './DoHexesHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const renderer = { selectFleetShips: vi.fn(), attackFocus: vi.fn() };
const rendererRef = { current: renderer };

function mount(): void {
  render(<LayoutProvider><DoHexesHost rendererRef={rendererRef} /></LayoutProvider>);
}

function select(ids: string[], focusId: string | null, focusKind: 'ship' | 'asteroid' | null = 'ship'): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId, focusKind: focusId === null ? null : focusKind } }); });
}

const cellOf = (testId: string): string | null =>
  screen.getByTestId(testId).closest('[data-cell]')?.getAttribute('data-cell') ?? null;

beforeEach(() => {
  stubMedia();
  resetFleetStatus();
  useUIStore.setState({
    phase: 'game', rightPanel: null, travelling: true, pilotMode: 'spectator', isDead: false,
    buildMode: false, placementKind: null, fleetPick: null, commandSpeed: 3,
    selection: { ids: [], focusId: null, focusKind: null },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendFleetOrder.mockReset();
  renderer.selectFleetShips.mockReset();
  renderer.attackFocus.mockReset();
});

describe('target do-hexes (S8)', () => {
  it('own ships + a tapped enemy: Follow under the thumb, Move to, Attack, More, Clear in the far corner', () => {
    mount();
    select(['a', 'b'], 'p2');
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('target');
    expect(cellOf('do-hex-follow')).toBe('0');
    expect(cellOf('do-hex-clear')).toBe('4');
    for (const k of ['move-to', 'attack', 'more']) expect(screen.getByTestId(`do-hex-${k}`)).toBeInTheDocument();
    expect(screen.queryByTestId('do-hex-patrol')).toBeNull();
  });

  it('Move to sends the move order to the target\'s position', () => {
    mount();
    select(['a', 'b'], 'p2');
    fireEvent.click(screen.getByTestId('do-hex-move-to'));
    expect(sendFleetOrder).toHaveBeenCalledWith(['a', 'b'], { kind: 'move', x: 120, y: -40, speed: 1 });
  });

  it('Attack is the T2 Lock: the renderer\'s attack-the-focus order', () => {
    mount();
    select(['a'], 'p2');
    fireEvent.click(screen.getByTestId('do-hex-attack'));
    expect(renderer.attackFocus).toHaveBeenCalledOnce();
  });

  it('More opens the target\'s Details', () => {
    mount();
    select(['a'], 'p2');
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('details');
  });

  it('Clear keeps the ships and drops the target; the plain fleet set comes back', () => {
    mount();
    select(['a', 'b'], 'p2');
    fireEvent.click(screen.getByTestId('do-hex-clear'));
    expect(renderer.selectFleetShips).toHaveBeenCalledWith(['a', 'b']);
    // The renderer publishes the focus-less selection back.
    select(['a', 'b'], null);
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('orders');
    expect(screen.getByTestId('do-hex-patrol')).toBeInTheDocument();
  });

  it('Follow is dimmed (no follow order for a ship that is not mine); a rock blocks Attack', () => {
    mount();
    select(['a'], 'swarm-3', 'asteroid');
    expect(screen.getByTestId('do-hex-follow')).toBeDisabled();
    expect(screen.getByTestId('do-hex-attack')).toBeDisabled();
    expect(screen.getByTestId('do-hex-move-to')).not.toBeDisabled();
  });

  it('no target hexes in Fly (the helm) even with a target', () => {
    useUIStore.setState({ pilotMode: 'pilot' });
    mount();
    select(['a'], 'p2');
    expect(screen.queryByTestId('do-hex-follow')).toBeNull();
  });
});
