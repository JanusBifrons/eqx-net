/**
 * Selection-HUD S2b: the do-hexes host. Command with own ships selected shows
 * Stance, Attack, Move / More, Patrol, Stop in the bottom-right honeycomb (each
 * an icon + a word); every order goes through the fleet command seam like the
 * left strip; Stance swaps the honeycomb to the stance choices; hidden while a
 * right panel is open, in Fly, in Build and with nothing of mine selected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { applyFleetStatus, resetFleetStatus, type FleetStatusUpdate } from '../fleet/fleetStatus';
import { resetFleetCommands, setFleetCommands } from '../fleet/fleetCommands';
import { LayoutProvider } from './LayoutProvider';
import { DoHexesHost } from './DoHexesHost';

function stubMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id, mode: 'defend', stance: 'defensive', activity: 'guarding', targetId: null, ...over,
});

const cmd = { setMode: vi.fn(), setStance: vi.fn(), stop: vi.fn(), setSpeed: vi.fn() };

function mount(): void {
  render(<LayoutProvider><DoHexesHost /></LayoutProvider>);
}

function select(ids: string[]): void {
  act(() => { useUIStore.setState({ selection: { ids, focusId: null, focusKind: null } }); });
}

const cellOf = (testId: string): string | null =>
  screen.getByTestId(testId).closest('[data-cell]')?.getAttribute('data-cell') ?? null;

beforeEach(() => {
  stubMedia();
  resetFleetStatus();
  setFleetCommands(cmd);
  useUIStore.setState({
    phase: 'game', rightPanel: null, travelling: true, pilotMode: 'spectator',
    buildMode: false, placementKind: null, fleetPick: null, commandSpeed: 3,
    selection: { ids: [], focusId: null, focusKind: null },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const f of Object.values(cmd)) f.mockReset();
  resetFleetCommands();
});

describe('do-hexes host (S2b)', () => {
  it('own ships in Command: six hexes, each an icon and a word, in the bottom-right slot', () => {
    mount();
    select(['a', 'b']);
    const words: Record<string, string> = {
      move: 'Move', attack: 'Attack', stop: 'Stop', stance: 'Stance', patrol: 'Patrol', more: 'More',
    };
    for (const [k, w] of Object.entries(words)) {
      expect(screen.getByTestId(`do-hex-${k}-word`).textContent, k).toBe(w);
      expect(screen.getByTestId(`do-hex-${k}`).getAttribute('aria-label'), k).toBeTruthy();
    }
    expect(screen.getByTestId('do-hexes').closest('[data-anchor="bottom-right"]')).not.toBeNull();
  });

  it('the rows read "Stance Attack Move / More Patrol Stop", Move under the thumb', () => {
    mount();
    select(['a']);
    expect(cellOf('do-hex-move')).toBe('0');
    expect(cellOf('do-hex-attack')).toBe('1');
    expect(cellOf('do-hex-stop')).toBe('2');
    expect(cellOf('do-hex-stance')).toBe('3');
    expect(cellOf('do-hex-patrol')).toBe('4');
    expect(cellOf('do-hex-more')).toBe('5');
  });

  it('none in Fly, in Build, with nothing selected, or while a right panel is open', () => {
    mount();
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    select(['a']);
    expect(screen.getByTestId('do-hexes')).toBeTruthy();
    act(() => { useUIStore.setState({ pilotMode: 'pilot' }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    act(() => { useUIStore.setState({ pilotMode: 'spectator', buildMode: true }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    act(() => { useUIStore.setState({ buildMode: false, rightPanel: 'contacts' }); });
    expect(screen.queryByTestId('do-hexes')).toBeNull();
    act(() => { useUIStore.setState({ rightPanel: null }); });
    expect(screen.getByTestId('do-hexes')).toBeTruthy();
  });

  it('Attack sends Hunt, Stop stops, through the fleet command seam', () => {
    mount();
    select(['a', 'b']);
    fireEvent.click(screen.getByTestId('do-hex-attack'));
    expect(cmd.setMode).toHaveBeenCalledWith(['a', 'b'], 'hunt');
    fireEvent.click(screen.getByTestId('do-hex-stop'));
    expect(cmd.stop).toHaveBeenCalledWith(['a', 'b']);
  });

  it('Patrol starts the route pick; Move arms (lit) and a second tap disarms', () => {
    mount();
    select(['a']);
    fireEvent.click(screen.getByTestId('do-hex-patrol'));
    expect(useUIStore.getState().fleetPick?.kind).toBe('patrol');
    expect(cmd.setMode).not.toHaveBeenCalled();
    act(() => { useUIStore.setState({ fleetPick: null }); });
    const move = (): HTMLElement => screen.getByTestId('do-hex-move');
    expect(move().getAttribute('data-lit')).toBe('false');
    fireEvent.click(move());
    expect(useUIStore.getState().fleetPick?.kind).toBe('move');
    expect(move().getAttribute('data-lit')).toBe('true');
    fireEvent.click(move());
    expect(useUIStore.getState().fleetPick).toBeNull();
  });

  it('More opens the Orders panel (and the hexes give way to it)', () => {
    mount();
    select(['a']);
    fireEvent.click(screen.getByTestId('do-hex-more'));
    expect(useUIStore.getState().rightPanel).toBe('orders');
    expect(screen.queryByTestId('do-hexes')).toBeNull();
  });

  it('the current order lights its hex', () => {
    applyFleetStatus([row('a', { mode: 'hunt' }), row('b', { mode: 'hunt' })]);
    mount();
    select(['a', 'b']);
    expect(screen.getByTestId('do-hex-attack').getAttribute('data-lit')).toBe('true');
    expect(screen.getByTestId('do-hex-patrol').getAttribute('data-lit')).toBe('false');
  });

  it('Stance swaps to the stance choices (current lit, Back far corner); a pick sends it and returns', () => {
    applyFleetStatus([row('a', { stance: 'defensive' })]);
    mount();
    select(['a']);
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('stance');
    expect(screen.queryByTestId('do-hex-move')).toBeNull();
    expect(screen.getByTestId('do-hex-stance-defensive').getAttribute('data-lit')).toBe('true');
    expect(cellOf('do-hex-back')).toBe('3');
    fireEvent.click(screen.getByTestId('do-hex-stance-holdFire'));
    expect(cmd.setStance).toHaveBeenCalledWith(['a'], 'holdFire');
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('orders');
  });

  it('Back returns without an order; deselecting closes the stance choices', () => {
    mount();
    select(['a']);
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    fireEvent.click(screen.getByTestId('do-hex-back'));
    expect(screen.getByTestId('do-hex-move')).toBeTruthy();
    expect(cmd.setStance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('do-hex-stance'));
    select([]);
    select(['a']);
    expect(screen.getByTestId('do-hexes').getAttribute('data-set')).toBe('orders');
  });
});
