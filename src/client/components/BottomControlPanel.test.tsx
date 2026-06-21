/**
 * Phase 5 WS-4 — the desktop RTS bottom control panel. Locks:
 *   - desktop + in-game gating (renders nothing off-game);
 *   - PILOTING shows the ship's weapon slots (active highlighted) + empty latent
 *     squares; number key 1..n + click switch the active slot;
 *   - SPECTATING flips to the flattened building palette; number key / click
 *     selects a building for placement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
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

  it('PILOTING — shows the weapon panel with the active slot highlighted + empty latent squares', () => {
    render(<BottomControlPanel />);
    const panel = screen.getByTestId('bottom-control-panel');
    expect(panel).toHaveAttribute('data-panel-mode', 'weapons');
    const firstSlotId = getShipKind('fighter').slots![0]!.id;
    expect(screen.getByTestId(`bcp-cell-slot:${firstSlotId}`)).toHaveAttribute('data-active', '1');
    // The fighter's two latent wing hardpoints render as empty squares.
    expect(screen.getAllByText('Empty').length).toBeGreaterThan(0);
  });

  it('PILOTING — number key 1 switches to the first weapon slot', () => {
    useUIStore.setState({ activeSlotId: 'bogus' });
    render(<BottomControlPanel />);
    pressKey('1');
    expect(useUIStore.getState().activeSlotId).toBe(getShipKind('fighter').slots![0]!.id);
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
