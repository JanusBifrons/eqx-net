/**
 * Owner play-test (2026-11-21): the inspector on a Shipyard under construction
 * read "UNPOWERED" while the grid had +150 spare. Unbuilt: BUILDING. Built and
 * unpowered: still UNPOWERED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';

function shipyard(built: boolean, powered: boolean): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([
        [9, { powered, netPower: built ? 150 : 0, connTo: [3], built, buildPct: built ? 1 : 0.4, deconstructPct: 0, owner: 'me-123' }],
      ]),
      swarm: new Map([[9, { kind: 2, shipKind: 'shipyard', radius: 200, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '9', name: 'Shipyard', hp: 2000, hpMax: 2000 });
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' } });
}

describe('EntityStatsPanel: power line while under construction', () => {
  beforeEach(() => resetSelectionStats());
  afterEach(() => {
    setGameClient(null);
    useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } });
  });

  it('an unbuilt Shipyard reads BUILDING, not UNPOWERED', () => {
    shipyard(false, false);
    render(<EntityStatsPanel />);
    const line = screen.getByTestId('entity-stats-power');
    expect(line).toHaveTextContent('BUILDING');
    expect(line).not.toHaveTextContent('UNPOWERED');
  });

  it('a built, unpowered Shipyard still reads UNPOWERED', () => {
    shipyard(true, false);
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('UNPOWERED');
  });

  it('a built, powered Shipyard reads its draw', () => {
    shipyard(true, true);
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent(/^PWR -/);
  });
});
