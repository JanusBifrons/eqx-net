/**
 * Lock for `EntityStatsPanel` (structures follow-up Item B6, invariant #13).
 *
 * The panel is the visible half of click-to-inspect:
 *   - renders the name + a hull bar when an entity is selected AND its stats
 *     are present in the `selectionStats` module singleton
 *   - renders a shield bar for ships, none for structures
 *   - is HIDDEN when `selectedEntityId` is null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { EntityStatsPanel } from './EntityStatsPanel.js';
import { selectionStats, applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { setGameClient } from '../net/clientSingleton.js';
import type { ColyseusGameClient } from '../net/ColyseusClient.js';

// Phase 4 WS-A2 — observe the Pilot action send without a live client.
const sendPilotShip = vi.fn();
vi.mock('../ships/shipActionsClient.js', () => ({
  sendPilotShip: (id: string) => sendPilotShip(id),
}));

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

  it('merges richer structure stats — build %, powered, PER-BUILDING power (Issue 8 + Phase-4 C5)', () => {
    setGameClient(
      fakeClient({
        // The grid AGGREGATE netPower (12) stays on the slice + the data-net-power
        // attr; the visible PWR line is now the building's OWN +gen/-drain (C5).
        structures: new Map([[7, { powered: true, netPower: 12, connTo: [], built: false, buildPct: 0.5, deconstructPct: 0 }]]),
        swarm: new Map([[7, { kind: 2, shipKind: 'solar', radius: 40, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Solar', hp: 300, hpMax: 300 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const panel = screen.getByTestId('entity-stats-panel');
    expect(panel).toHaveAttribute('data-build-pct', '50');
    expect(panel).toHaveAttribute('data-powered', '1');
    expect(panel).toHaveAttribute('data-net-power', '12'); // grid aggregate (unchanged attr)
    expect(screen.getByText('BUILD')).toBeInTheDocument(); // mid-construction bar shown
    // C5 — the PWR line is the SOLAR's own generation (+30), NOT the grid total (+12).
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR +30');
    expect(panel).toHaveAttribute('data-self-power', '30');
  });

  // ── Phase-4 C5 — the panel shows the SELECTED building's own drain/surplus,
  // not the shared grid aggregate (which was identical for every building in a
  // grid). Pure catalogue lookup (powerOutput − powerConsumption). ──
  it('shows a CONSUMER building its own negative draw — turret PWR -15 (C5)', () => {
    setGameClient(
      fakeClient({
        // Grid aggregate +35, but the turret itself DRAINS 15.
        structures: new Map([[9, { powered: true, netPower: 35, connTo: [3], built: true, buildPct: 1, deconstructPct: 0 }]]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR -15');
    expect(screen.getByTestId('entity-stats-panel')).toHaveAttribute('data-self-power', '-15');
  });

  it('shows the Capital its own generation — PWR +50 (C5)', () => {
    setGameClient(
      fakeClient({
        structures: new Map([[1, { powered: true, netPower: 35, connTo: [], built: true, buildPct: 1, deconstructPct: 0 }]]),
        swarm: new Map([[1, { kind: 2, shipKind: 'capital', radius: 80, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '1', name: 'Capital', hp: 5000, hpMax: 5000 });
    useUIStore.setState({ selectedEntityId: 'swarm-1', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-power')).toHaveTextContent('PWR +50');
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

  // ── Phase-4 C3 — structure hull renders INSTANTLY from the slice (no pop-in) ─
  // Pre-fix the structure hull came ONLY from the server entity_stats round-trip,
  // so the bar showed a spinner (data-stats-pending=1, hull 0) until a packet
  // landed ~one RTT later — the "hull UI pops in" report. The slice now carries
  // hpPct (0..1 on the mirror), so hull is non-zero on the FIRST polled frame
  // with NO matching server packet. FAILS on current main (slice has no hpPct →
  // spinner).
  it('renders structure hull from the SLICE on the first frame, no spinner (C3)', () => {
    setGameClient(
      fakeClient({
        // hpPct 0.8 ⇒ 80 % hull, client-resident — no server stats needed.
        structures: new Map([[7, { powered: true, netPower: 30, connTo: [], built: true, buildPct: 1, deconstructPct: 0, hpPct: 0.8 }]]),
        swarm: new Map([[7, { kind: 2, shipKind: 'solar', radius: 40, x: 0, y: 0 }]]),
      }),
    );
    // NO matching stats packet (the singleton holds a different id).
    selectionStats.id = 'nomatch';
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const panel = screen.getByTestId('entity-stats-panel');
    expect(panel).toHaveAttribute('data-hull-pct', '80'); // instant from the slice
    expect(panel).not.toHaveAttribute('data-stats-pending'); // no spinner pop-in
    expect(screen.queryByTestId('entity-stats-spinner')).toBeNull();
    expect(screen.getByText('HULL')).toBeInTheDocument(); // the hull bar, not a spinner
  });

  // ── Phase-4 C4 — connector connection count "N / 6" (QOL, connectors ONLY) ──
  // The user asked for a connection count on CONNECTORS specifically ("It
  // shouldn't really apply to other structures"). It reads the client-resident
  // slice (connTo.length) + the catalogue maxConnections (6) — instant, no server
  // round-trip. Detection is the swarm subtype byte (shipKind === 'connector').
  it('shows a CONN "N / 6" count for a selected CONNECTOR (C4)', () => {
    setGameClient(
      fakeClient({
        structures: new Map([
          [7, { powered: true, netPower: 0, connTo: [3, 5], built: true, buildPct: 1, deconstructPct: 0 }],
        ]),
        swarm: new Map([[7, { kind: 2, shipKind: 'connector', radius: 10, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Connector', hp: 200, hpMax: 200 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const conn = screen.getByTestId('entity-stats-conn');
    expect(conn).toHaveTextContent('CONN 2 / 6');
    expect(screen.getByTestId('entity-stats-panel')).toHaveAttribute('data-conn-count', '2');
  });

  it('does NOT show the CONN count for a non-connector structure (solar) (C4)', () => {
    setGameClient(
      fakeClient({
        structures: new Map([
          [8, { powered: true, netPower: 30, connTo: [3], built: true, buildPct: 1, deconstructPct: 0 }],
        ]),
        swarm: new Map([[8, { kind: 2, shipKind: 'solar', radius: 40, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '8', name: 'Solar Panel', hp: 300, hpMax: 300 });
    useUIStore.setState({ selectedEntityId: 'swarm-8', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('entity-stats-conn')).toBeNull();
    expect(screen.getByTestId('entity-stats-panel')).not.toHaveAttribute('data-conn-count');
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

  // ── Phase 4 WS-A2 — the in-world Pilot action on an OWNED lingering hull. ──
  it("shows a Pilot action on the LOCAL player's own lingering hull and sends pilot_ship on click", () => {
    sendPilotShip.mockClear();
    setGameClient(
      fakeClient({
        localPlayerId: 'me',
        lingeringShips: new Map([['ship-mine', { ownerPlayerId: 'me', displayName: 'My Hull', kind: 'fighter', x: 0, y: 0 }]]),
      }),
    );
    useUIStore.setState({ selectedEntityId: 'ship-mine', selectedEntityKind: 'lingering' });
    render(<EntityStatsPanel />);
    const btn = screen.getByTestId('ship-action-pilot');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    // The selection id IS the shipInstanceId (the lingeringShips map key).
    expect(sendPilotShip).toHaveBeenCalledWith('ship-mine');
  });

  it("does NOT show a Pilot action on ANOTHER player's lingering hull", () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me',
        lingeringShips: new Map([['ship-theirs', { ownerPlayerId: 'someone-else', displayName: 'Their Hull', kind: 'fighter', x: 0, y: 0 }]]),
      }),
    );
    useUIStore.setState({ selectedEntityId: 'ship-theirs', selectedEntityKind: 'lingering' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('ship-action-pilot')).toBeNull();
  });

  // ── Owner readout — identify WHOSE base a structure is (other players'
  // structures are a core part of the game, not a bug). "you" for the local
  // player's own base, else a truncated owner id. Reads the slice `owner` field
  // + `mirror.localPlayerId`, client-resident → instant. ──
  it("shows OWNER <display name> for another player's structure (never a raw id)", () => {
    setGameClient(
      fakeClient({
        localPlayerId: '7bc27d53-mine',
        structures: new Map([
          [7, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: '7fc842fe-other', ownerName: 'Nova' }],
        ]),
        swarm: new Map([[7, { kind: 2, shipKind: 'capital', radius: 80, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Capital', hp: 5000, hpMax: 5000 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const owner = screen.getByTestId('entity-stats-owner');
    expect(owner).toHaveTextContent('OWNER Nova'); // the player's display name
    expect(owner).not.toHaveTextContent('you');
    expect(owner).not.toHaveTextContent('7fc842fe'); // NEVER a raw playerId
    expect(screen.getByTestId('entity-stats-panel')).toHaveAttribute('data-structure-owner', 'Nova');
  });

  it("shows OWNER Unknown for an orphaned structure (owner doesn't resolve to a user)", () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        // owner present but NO ownerName → the server couldn't resolve it to a DB
        // user (an orphaned structure, which the server logs).
        structures: new Map([
          [7, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'gone-player' }],
        ]),
        swarm: new Map([[7, { kind: 2, shipKind: 'capital', radius: 80, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Capital', hp: 5000, hpMax: 5000 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-owner')).toHaveTextContent('OWNER Unknown');
  });

  it("shows OWNER you for the local player's own structure", () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [8, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[8, { kind: 2, shipKind: 'capital', radius: 80, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '8', name: 'Capital', hp: 5000, hpMax: 5000 });
    useUIStore.setState({ selectedEntityId: 'swarm-8', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-owner')).toHaveTextContent('OWNER you');
  });

  // ── Phase-1 issue 6 — owner-only action buttons (deconstruct / reconnect /
  // clear connections). Gated on owner === local; clear is connector-only. ──
  it('shows Deconstruct + Reconnect on an OWNED structure (no Clear for non-connector)', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [8, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[8, { kind: 2, shipKind: 'solar', radius: 40, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '8', name: 'Solar', hp: 300, hpMax: 300 });
    useUIStore.setState({ selectedEntityId: 'swarm-8', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('structure-action-deconstruct')).toBeInTheDocument();
    expect(screen.getByTestId('structure-action-reconnect')).toBeInTheDocument();
    expect(screen.queryByTestId('structure-action-clear')).toBeNull(); // non-connector
  });

  it('shows the Clear-connections button on an OWNED connector', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [7, { powered: true, netPower: 0, connTo: [3, 5], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[7, { kind: 2, shipKind: 'connector', radius: 10, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Connector', hp: 200, hpMax: 200 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('structure-action-clear')).toBeInTheDocument();
  });

  it("hides ALL action buttons on ANOTHER player's structure", () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [7, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'other-1', ownerName: 'Nova' }],
        ]),
        swarm: new Map([[7, { kind: 2, shipKind: 'connector', radius: 10, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '7', name: 'Connector', hp: 200, hpMax: 200 });
    useUIStore.setState({ selectedEntityId: 'swarm-7', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('entity-stats-actions')).toBeNull();
  });

  // ── Phase 4 WS-B4 — structure leveling: the LVL line + the Upgrade action ──
  // The level rides the client-resident structures slice (`level`); the inspector
  // shows a `LVL n` line for a LEVELED structure (>1) and an Upgrade action on an
  // OWNED, BUILT, below-cap structure. Detection of "structure" is the swarm
  // subtype byte (kind === 2).
  it('shows a LVL n line for a leveled structure', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', level: 3 }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-level')).toHaveTextContent('LVL 3');
    expect(screen.getByTestId('entity-stats-panel')).toHaveAttribute('data-structure-level', '3');
  });

  it('does NOT show a LVL line for a level-1 (un-levelled) structure', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('entity-stats-level')).toBeNull();
  });

  it('shows an Upgrade action on an OWNED, BUILT structure + sends upgrade_structure on click', () => {
    const sendSpy = vi.fn();
    setGameClient({
      mirror: {
        localPlayerId: 'me-123',
        structures: new Map([
          [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      },
      getRoom: () => ({ send: sendSpy }),
    } as unknown as ColyseusGameClient);
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const btn = screen.getByTestId('structure-action-upgrade');
    fireEvent.click(btn);
    expect(sendSpy).toHaveBeenCalledWith('upgrade_structure', {
      type: 'upgrade_structure',
      entityId: 9,
    });
  });

  it('does NOT show the Upgrade action while a structure is still UNDER CONSTRUCTION', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [9, { powered: true, netPower: 0, connTo: [], built: false, buildPct: 0.5, deconstructPct: 0, owner: 'me-123' }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('structure-action-upgrade')).toBeNull();
  });

  it('does NOT show the Upgrade action at the level cap', () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          // level 5 = STRUCTURE_LEVEL_CAP → no further upgrade.
          [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'me-123', level: 5 }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.getByTestId('entity-stats-level')).toHaveTextContent('LVL 5');
    expect(screen.queryByTestId('structure-action-upgrade')).toBeNull();
  });

  it("does NOT show the Upgrade action on ANOTHER player's structure", () => {
    setGameClient(
      fakeClient({
        localPlayerId: 'me-123',
        structures: new Map([
          [9, { powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0, owner: 'other-1', ownerName: 'Nova' }],
        ]),
        swarm: new Map([[9, { kind: 2, shipKind: 'turret', radius: 36, x: 0, y: 0 }]]),
      }),
    );
    applySelectionStats({ id: '9', name: 'Turret', hp: 600, hpMax: 600 });
    useUIStore.setState({ selectedEntityId: 'swarm-9', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    expect(screen.queryByTestId('structure-action-upgrade')).toBeNull();
  });

  it('the Deconstruct button shows Cancel state + sends the toggle action with the entityId', () => {
    const sendSpy = vi.fn();
    setGameClient({
      mirror: {
        localPlayerId: 'me-123',
        structures: new Map([
          [8, { powered: true, netPower: 0, connTo: [], built: false, buildPct: 0.3, deconstructPct: 0.2, isDeconstructing: true, owner: 'me-123' }],
        ]),
        swarm: new Map([[8, { kind: 2, shipKind: 'solar', radius: 40, x: 0, y: 0 }]]),
      },
      getRoom: () => ({ send: sendSpy }),
    } as unknown as ColyseusGameClient);
    applySelectionStats({ id: '8', name: 'Solar', hp: 300, hpMax: 300 });
    useUIStore.setState({ selectedEntityId: 'swarm-8', selectedEntityKind: 'structure' });
    render(<EntityStatsPanel />);
    const btn = screen.getByTestId('structure-action-deconstruct');
    expect(btn).toHaveAttribute('data-active', '1'); // already deconstructing → Cancel state
    fireEvent.click(btn);
    expect(sendSpy).toHaveBeenCalledWith('structure_action', {
      type: 'structure_action',
      id: 8,
      action: 'toggle_deconstruct',
    });
  });
});
