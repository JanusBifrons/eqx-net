/**
 * Lock for the building settings window: the cog in the inspector's owner
 * action row opens a tabbed window on the Power tab (read-only numbers from
 * the structure slice), and a building you do not own has no cog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { settingsTabsFor } from './StructureSettingsModal.js';

function seedTurret(owner: string, drawFull: boolean): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([[9, { powered: true, netPower: 35, connTo: [3], built: true, buildPct: 1, deconstructPct: 0, owner, ownerName: 'Nova', drawFull }]]),
      swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' } });
}

describe('StructureSettingsModal', () => {
  beforeEach(() => {
    useUIStore.setState({ selection: { ids: [], focusId: null, focusKind: null } });
    resetSelectionStats();
  });
  afterEach(() => setGameClient(null));

  it('cog opens the settings window on the Power tab', () => {
    seedTurret('me-123', true);
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('structure-settings')).toBeNull();
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getByTestId('structure-settings')).toBeInTheDocument();
    expect(screen.getByTestId('structure-settings-tab-power')).toHaveAttribute('aria-selected', 'true');
    // Same figures as the inspector's PWR line: an engaging turret draws 15 in full.
    const power = screen.getByTestId('structure-settings-power');
    expect(power).toHaveAttribute('data-self-power', '-15');
    expect(power).toHaveAttribute('data-load', 'full');
    expect(screen.getByTestId('settings-power-grid')).toHaveTextContent('+35');
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR -15');
    fireEvent.click(screen.getByTestId('structure-settings-close'));
    expect(screen.queryByTestId('structure-settings')).toBeNull();
  });

  it('an idle building reads Idle on the Power tab', () => {
    seedTurret('me-123', false);
    render(<EntityStatsPanel />);
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getByTestId('structure-settings-power')).toHaveAttribute('data-load', 'idle');
    expect(screen.getByTestId('settings-power-draw')).toHaveTextContent('-3');
  });

  it('no cog on a building you do not own', () => {
    seedTurret('other-1', true);
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-settings')).toBeNull();
  });

  it('every building kind has the Power tab first', () => {
    expect(settingsTabsFor('turret')[0]?.id).toBe('power');
    expect(settingsTabsFor('solar')[0]?.id).toBe('power');
  });
});
