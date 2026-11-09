/**
 * Phase 5 WS-4 — the desktop RTS bottom control panel. Locks:
 *   - desktop + in-game gating (renders nothing off-game);
 *   - PILOTING renders nothing and leaves the number keys alone (the fire-control
 *     weapon strip replaced the weapon-slot row; 1–9 select weapon groups);
 *   - SPECTATING flips to the flattened building palette; number key / click
 *     selects a building for placement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { BottomControlPanel } from './BottomControlPanel.js';

const pressKey = (key: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
};

describe('BottomControlPanel (Phase 5 WS-4)', () => {
  beforeEach(() => {
    useUIStore.setState({
      phase: 'game',
      pilotMode: 'pilot',
      selectedShipKind: 'fighter',
      activeSlotId: 'primary',
      placementKind: null,
    });
  });

  it('renders nothing off-game', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    render(<BottomControlPanel />);
    expect(screen.queryByTestId('bottom-control-panel')).toBeNull();
  });

  it('PILOTING — renders nothing; number keys leave the slot + placement alone', () => {
    useUIStore.setState({ activeSlotId: 'bogus' });
    render(<BottomControlPanel />);
    expect(screen.queryByTestId('bottom-control-panel')).toBeNull();
    pressKey('1');
    expect(useUIStore.getState().activeSlotId).toBe('bogus');
    expect(useUIStore.getState().placementKind).toBeNull();
  });

  it('SPECTATING — economy v2: packed counts label non-starter kinds; one you have none of is greyed + unpickable', () => {
    useUIStore.setState({ pilotMode: 'spectator', packedStock: { 'structure:smelter': 2 } });
    render(<BottomControlPanel />);
    const smelter = screen.getByTestId('bcp-cell-build:smelter');
    expect(smelter.textContent).toContain('Smelter ×2');
    fireEvent.click(smelter);
    expect(useUIStore.getState().placementKind).toBe('smelter');
    useUIStore.setState({ placementKind: null });
    const turret = screen.getByTestId('bcp-cell-build:missile_turret');
    expect(turret.textContent).toContain('buy packed');
    fireEvent.click(turret);
    expect(useUIStore.getState().placementKind).toBeNull();
    // Starter kinds are never locked.
    expect(screen.getByTestId('bcp-cell-build:solar').textContent).not.toContain('buy packed');
    useUIStore.setState({ packedStock: null });
  });

  it('SPECTATING — flips to the flattened building palette; click selects a building', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<BottomControlPanel />);
    expect(screen.getByTestId('bottom-control-panel')).toHaveAttribute('data-panel-mode', 'build');
    fireEvent.click(screen.getByTestId('bcp-cell-build:solar'));
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  it('SPECTATING — number key 2 selects the 2nd building (connector)', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    render(<BottomControlPanel />);
    pressKey('2'); // BUILD order: capital(1), connector(2), …
    expect(useUIStore.getState().placementKind).toBe('connector');
  });
});
