/**
 * Owner bug (2026-11-20): "It's in fly mode and yet you can build stuff? ...
 * It's supposed to be quite a clear separator." Building MANAGEMENT on the
 * inspector card (deconstruct, reconnect, clear, upgrade, recipe, ...) shows
 * only in Build mode (`canManageBuildings`); in Fly and Command your own
 * building's card is read-only info. Pilot services (repair my ship, refine
 * my salvage) are not management and show in every mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats, selectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import { canManageBuildings } from '../structures/buildingManagement.js';

vi.mock('../ships/shipActionsClient.js', () => ({ sendPilotShip: vi.fn() }));

const MANAGEMENT = [
  'structure-action-deconstruct',
  'structure-action-reconnect',
  'structure-action-upgrade',
  'structure-action-recipe',
] as const;

/** My own built Refinery (a processor: recipe button; level 1: upgrade). */
function ownRefinery(): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([
        [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', prodState: 1 }],
      ]),
      swarm: new Map([[9, { kind: 2, shipKind: 'refinery', radius: 243, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '9', name: 'Refinery', hp: 1800, hpMax: 1800 });
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-9', focusKind: 'structure' } });
}

/** My own built Capital holding salvage (repair + refine offered). */
function ownCapitalWithSalvage(): void {
  setGameClient({
    mirror: {
      localPlayerId: 'me-123',
      structures: new Map([
        [8, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
      ]),
      swarm: new Map([[8, { kind: 2, shipKind: 'capital', radius: 80, x: 0, y: 0 }]]),
    },
  } as unknown as ColyseusGameClient);
  applySelectionStats({ id: '8', name: 'Capital', hp: 5000, hpMax: 5000 });
  selectionStats.holdLine = '40 Salvage';
  selectionStats.holdUse = '40/500';
  selectionStats.holdSalvage = 40;
  useUIStore.setState({ selection: { ids: [], focusId: 'swarm-8', focusKind: 'structure' } });
}

describe('EntityStatsPanel — building management is Build mode only', () => {
  beforeEach(() => {
    resetSelectionStats();
    useUIStore.setState({ pilotMode: 'pilot', buildMode: false, selection: { ids: [], focusId: null, focusKind: null } });
  });
  afterEach(() => {
    setGameClient(null);
    resetSelectionStats();
  });

  it('canManageBuildings is true in Build only', () => {
    expect(canManageBuildings({ pilotMode: 'pilot', buildMode: false })).toBe(false); // Fly
    expect(canManageBuildings({ pilotMode: 'spectator', buildMode: false })).toBe(false); // Command
    expect(canManageBuildings({ pilotMode: 'spectator', buildMode: true })).toBe(true); // Build
  });

  it('in Fly mode your own building\'s card has no cog/deconstruct/upgrade', () => {
    ownRefinery();
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-owner')).toHaveTextContent('OWNER you'); // still the info card
    for (const id of MANAGEMENT) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('in Command mode your own building\'s card has no management actions either', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    ownRefinery();
    render(<EntityStatsPanel />);
    for (const id of MANAGEMENT) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('in Build mode your own building\'s card has them', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true });
    ownRefinery();
    render(<EntityStatsPanel />);
    for (const id of MANAGEMENT) expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it('repair and refine still show in Fly mode (pilot services, not management)', () => {
    ownCapitalWithSalvage();
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('structure-action-repair-ship')).toBeInTheDocument();
    expect(screen.getByTestId('structure-action-refine')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-deconstruct')).toBeNull();
  });
});
