/**
 * The ship-speed telegraph (Stop / ⅓ / ⅔ / Full) is a Command control, never
 * a Fly one (owner, 2026-11-21: "Command is where you click move to go, and
 * where you set the speed. Fly is just manual"). It shows in Command while
 * ships are selected, and a tap sets the Command speed and re-paces the
 * selection with the shared fraction (`HELM_SPEED_FRACTION`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HELM_SPEED_FRACTION } from '@core/helm/helm';
import { useUIStore } from '../state/store.js';
import { setFleetCommands, resetFleetCommands } from '../fleet/fleetCommands.js';
import { HelmPanel } from './HelmPanel.js';

function inGame(pilotMode: 'pilot' | 'spectator', buildMode = false, ids: string[] = ['a', 'b']): void {
  useUIStore.setState({
    phase: 'game', travelling: true, pilotMode, buildMode, commandSpeed: 3,
    selection: { ids, focusId: null, focusKind: null },
  });
}

afterEach(() => {
  cleanup();
  resetFleetCommands();
  useUIStore.setState({
    pilotMode: 'pilot', buildMode: false, travelling: false, commandSpeed: 3,
    selection: { ids: [], focusId: null, focusKind: null },
  });
});

describe('HelmPanel', () => {
  it('is hidden in Fly, even with ships selected', () => {
    inGame('pilot');
    render(<HelmPanel />);
    expect(screen.queryByTestId('helm-panel')).toBeNull();
  });

  it('shows in Command with ships selected, on the current Command speed', () => {
    inGame('spectator');
    render(<HelmPanel />);
    expect(screen.getByTestId('helm-panel').getAttribute('data-helm-speed')).toBe('3');
  });

  it('is hidden in Command with nothing selected', () => {
    inGame('spectator', false, []);
    render(<HelmPanel />);
    expect(screen.queryByTestId('helm-panel')).toBeNull();
  });

  it('is hidden in Build', () => {
    inGame('spectator', true);
    render(<HelmPanel />);
    expect(screen.queryByTestId('helm-panel')).toBeNull();
  });

  it('a tap sets the Command speed and re-paces the selection', () => {
    const sent: { ids: readonly string[]; fraction: number }[] = [];
    setFleetCommands({ setSpeed: (ids, fraction) => { sent.push({ ids: [...ids], fraction }); } });
    inGame('spectator');
    render(<HelmPanel />);
    fireEvent.click(screen.getByTestId('helm-speed-1'));
    expect(useUIStore.getState().commandSpeed).toBe(1);
    expect(screen.getByTestId('helm-panel').getAttribute('data-helm-speed')).toBe('1');
    fireEvent.click(screen.getByTestId('helm-speed-0'));
    expect(sent).toEqual([
      { ids: ['a', 'b'], fraction: HELM_SPEED_FRACTION[1] },
      { ids: ['a', 'b'], fraction: 0 },
    ]);
  });
});
