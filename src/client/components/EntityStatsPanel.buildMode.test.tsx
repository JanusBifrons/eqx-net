/**
 * Owner bug (2026-11-20): "It's in fly mode and yet you can build stuff? ...
 * It's supposed to be quite a clear separator." Building MANAGEMENT shows
 * only in Build mode (`canManageBuildings`): the card's Open button, which
 * opens the side panel where deconstruct, reconnect, clear and upgrade live
 * (Manage tab). In Fly and Command your own building's card is read-only
 * info. Pilot services (repair my ship, refine my salvage) are not
 * management and show in every mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  'structure-action-settings',
] as const;

/** My own built Refinery (settings cog; level 1: upgrade). */
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
    expect(screen.getByTestId('entity-stats-owner')).toHaveTextContent('you'); // still the info card
    for (const id of MANAGEMENT) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('in Command mode your own building\'s card has no management actions either', () => {
    useUIStore.setState({ pilotMode: 'spectator' });
    ownRefinery();
    render(<EntityStatsPanel />);
    for (const id of MANAGEMENT) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('in Build mode your own building\'s card has Open; the rest sit in the Manage tab', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true });
    ownRefinery();
    render(<EntityStatsPanel />);
    const card = screen.getByTestId('entity-stats-panel');
    expect(within(card).getByTestId('structure-action-settings')).toHaveTextContent('Open');
    for (const id of MANAGEMENT.slice(0, 3)) expect(within(card).queryByTestId(id)).toBeNull();
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    fireEvent.click(screen.getByTestId('structure-settings-tab-access'));
    const manage = screen.getByTestId('structure-settings-manage');
    for (const id of MANAGEMENT.slice(0, 3)) expect(within(manage).getByTestId(id)).toBeInTheDocument();
  });

  it('my own shipyard: the card has Open and no deconstruct; the Manage tab has deconstruct', () => {
    useUIStore.setState({ pilotMode: 'spectator', buildMode: true });
    setGameClient({
      mirror: {
        localPlayerId: 'me-123',
        structures: new Map([[5, { powered: true, netPower: 40, connTo: [1], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', prodState: 1, prodFrac: 0.5 }]]),
        swarm: new Map([[5, { kind: 2, shipKind: 'shipyard', radius: 200, x: 0, y: 0 }]]),
      },
    } as unknown as ColyseusGameClient);
    applySelectionStats({ id: '5', name: 'Shipyard', hp: 2000, hpMax: 2000 });
    useUIStore.setState({ selection: { ids: [], focusId: 'swarm-5', focusKind: 'structure' } });
    render(<EntityStatsPanel />);
    const card = screen.getByTestId('entity-stats-panel');
    expect(within(card).getByTestId('structure-action-settings')).toBeInTheDocument();
    expect(within(card).queryByTestId('structure-action-deconstruct')).toBeNull();
    // Row 2: what it is making, half done; the chip says it is running.
    expect(within(card).getByTestId('entity-stats-making')).toHaveAttribute('data-prod-pct', '50');
    expect(within(card).getByTestId('entity-stats-status')).toHaveTextContent('Running');
    fireEvent.click(screen.getByTestId('structure-action-settings'));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Power', 'Build', 'Manage']);
    fireEvent.click(screen.getByTestId('structure-settings-tab-access'));
    expect(within(screen.getByTestId('structure-settings-manage')).getByTestId('structure-action-deconstruct')).toBeInTheDocument();
  });

  it('repair and refine still show in Fly mode (pilot services, not management)', () => {
    ownCapitalWithSalvage();
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('structure-action-repair-ship')).toBeInTheDocument();
    expect(screen.getByTestId('structure-action-refine')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-deconstruct')).toBeNull();
  });
});
