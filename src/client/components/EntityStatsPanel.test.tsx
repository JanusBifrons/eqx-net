/**
 * Lock for `EntityStatsPanel` (structures follow-up Item B6, invariant #13).
 *
 * The panel is the visible half of click-to-inspect:
 *   - renders the name + a hull bar when an entity is selected AND its stats
 *     are present in the `selectionStats` module singleton
 *   - renders a shield bar for ships, none for structures
 *   - is HIDDEN when `selectedEntityId` is null
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { selectionStats, applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';
import type { StructureRenderState } from '@core/contracts/IRenderer';

/** Minimal fake client exposing just `mirror.structures` for the richer-stats read. */
function fakeClientWithStructure(entityId: number, st: StructureRenderState): ColyseusGameClient {
  return { mirror: { structures: new Map([[entityId, st]]) } } as unknown as ColyseusGameClient;
}

describe('EntityStatsPanel', () => {
  beforeEach(() => {
    useUIStore.setState({ selectedEntityId: null, selectedEntityKind: null });
    resetSelectionStats();
  });
  afterEach(() => {
    setGameClient(null);
  });

  it('is hidden when nothing is selected', () => {
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('entity-stats-panel')).toBeNull();
  });

  it('renders name + hull bar for a selected ship with stats present', () => {
    applySelectionStats({ id: 'p1', name: 'Ada', hp: 75, hpMax: 100, shield: 30, shieldMax: 60 });
    useUIStore.setState({ selectedEntityId: 'p1', selectedEntityKind: 'ship' });
    render(<EntityStatsPanel />);
    const panel = screen.getByTestId('entity-stats-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Ada');
    expect(panel).toHaveAttribute('data-entity-name', 'Ada');
  });

  it('renders a shield bar for a ship and none for a structure', () => {
    // Ship: shield present.
    applySelectionStats({ id: 'p1', name: 'Ada', hp: 75, hpMax: 100, shield: 30, shieldMax: 60 });
    useUIStore.setState({ selectedEntityId: 'p1', selectedEntityKind: 'ship' });
    const { unmount } = render(<EntityStatsPanel />);
    // Two bar tracks (shield + hull) → look for the SHLD cap.
    expect(screen.getByText('SHLD')).toBeInTheDocument();
    unmount();

    // Structure: no shield.
    resetSelectionStats();
    applySelectionStats({ id: '42', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: '42', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Turret');
    expect(screen.queryByText('SHLD')).toBeNull();
  });

  it('shows a placeholder name until the matching stats packet arrives', () => {
    // Selected, but the singleton still holds the PREVIOUS entity's id.
    selectionStats.id = 'other';
    useUIStore.setState({ selectedEntityId: 'p1', selectedEntityKind: 'ship' });
    render(<EntityStatsPanel />);
    // Visible (selected) but name falls back to the kind label, not stale data.
    expect(screen.getByTestId('entity-stats-panel')).toBeInTheDocument();
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Ship');
  });

  // ── Structure health id-namespace mismatch (playtest 2026-06-10 Issue 3) ────
  // "The health on buildings doesn't work when a building is selected." The
  // renderer selects a structure as `swarm-<entityId>` (mirror form) but the
  // server echoes the STRIPPED numeric id in the stats packet, so the guard
  // `selectionStats.id !== id` never matched → permanent placeholder. The fix
  // compares against the WIRE id (toSelectWire), the single mapping site.
  it('shows structure hull from the WIRE id even though the selection holds the swarm- mirror id', () => {
    applySelectionStats({ id: '42', name: 'Capital', hp: 1200, hpMax: 1500 });
    useUIStore.setState({ selectedEntityId: 'swarm-42', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    // Fails on the pre-fix code: '42' !== 'swarm-42' → placeholder "Structure", hp 0.
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Capital');
    expect(screen.getByTestId('entity-stats-panel')).toHaveAttribute('data-hull-pct', '80');
  });

  it('merges richer structure stats — build %, powered, net power (Issue 8)', () => {
    setGameClient(
      fakeClientWithStructure(7, {
        powered: true,
        netPower: 12,
        connTo: [],
        built: false,
        buildPct: 0.5,
        deconstructPct: 0,
      }),
    );
    applySelectionStats({ id: '7', name: 'Solar', hp: 300, hpMax: 300 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const panel = screen.getByTestId('entity-stats-panel');
    expect(panel).toHaveAttribute('data-build-pct', '50');
    expect(panel).toHaveAttribute('data-powered', '1');
    expect(panel).toHaveAttribute('data-net-power', '12');
    expect(screen.getByText('BUILD')).toBeInTheDocument(); // mid-construction bar shown
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR +12');
  });
});
