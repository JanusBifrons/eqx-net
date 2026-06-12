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

/** Flexible fake client — seed any mirror maps the panel reads (swarm /
 *  lingeringShips / structures). */
function fakeClient(mirror: Record<string, unknown>): ColyseusGameClient {
  return { mirror } as unknown as ColyseusGameClient;
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

  // ── WS-9/R2.8 — structure stats are INSTANT (slice is client-resident); only
  // hull waits for the server packet (a spinner, not a 1-second "pop-in"). ──
  it('shows structure build/power INSTANTLY with a spinner for hull until the packet (R2.8)', () => {
    setGameClient(
      fakeClient({
        structures: new Map([[7, { powered: true, netPower: 12, connTo: [], built: false, buildPct: 0.5, deconstructPct: 0 }]]),
        swarm: new Map([[7, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    // NO matching stats packet — the singleton holds a different id.
    selectionStats.id = 'nomatch';
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const panel = screen.getByTestId('entity-stats-panel');
    expect(panel).toHaveAttribute('data-build-pct', '50'); // instant from the slice
    expect(panel).toHaveAttribute('data-powered', '1'); // instant
    expect(panel).toHaveAttribute('data-stats-pending', '1'); // hull awaiting the packet
    expect(screen.getByTestId('entity-stats-spinner')).toBeInTheDocument();
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Turret'); // instant name
    expect(screen.queryByText('HULL')).toBeNull(); // hull bar replaced by the spinner
  });

  // ── WS-9/R2.23 — asteroids + lingering hulls are selectable, read from the
  // mirror (no server channel), with no hull bar. ──
  it('an asteroid shows a SIZE readout (untouched rock), no hull bar (R2.23)', () => {
    setGameClient(fakeClient({ swarm: new Map([[5, { kind: 0, radius: 48, x: 0, y: 0 }]]) }));
    useUIStore.setState({ selectedEntityId: 'swarm-5', selectedEntityKind: 'asteroid' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Asteroid');
    expect(screen.getByTestId('entity-stats-info')).toHaveTextContent('SIZE 48');
    expect(screen.queryByText('HULL')).toBeNull(); // indestructible — no hull bar
  });

  it('a MINED asteroid shows its resources (R2.23)', () => {
    setGameClient(fakeClient({ swarm: new Map([[5, { kind: 0, radius: 48, resources: 300, resourcesMax: 1000, x: 0, y: 0 }]]) }));
    useUIStore.setState({ selectedEntityId: 'swarm-5', selectedEntityKind: 'asteroid' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-info')).toHaveTextContent('RES 300 / 1000');
  });

  it('a lingering hull shows WHOSE it is, no hull bar (R2.23)', () => {
    setGameClient(fakeClient({ lingeringShips: new Map([['linger-9', { ownerPlayerId: 'player-abc', displayName: 'Nova', kind: 'heavy', x: 0, y: 0 }]]) }));
    useUIStore.setState({ selectedEntityId: 'linger-9', selectedEntityKind: 'lingering' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-name')).toHaveTextContent('Nova');
    expect(screen.getByTestId('entity-stats-info')).toHaveTextContent('heavy');
    expect(screen.queryByText('HULL')).toBeNull();
  });
});
