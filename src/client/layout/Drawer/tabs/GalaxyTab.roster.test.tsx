/**
 * Phase 5 — `GalaxyTab` mounts `ShipRosterPanel` so the player can switch
 * ships mid-game without disconnecting back to the galaxy map. This test
 * exercises the mount + the existing arrival picker co-existing.
 *
 * Test assertions are intentionally narrow: we verify mount + co-existence,
 * not interaction (the spawn-from-card → engageTransit handshake is
 * covered end-to-end in `tests/e2e/phase5-ingame-roster.spec.ts`).
 *
 * `ShipRosterPanel` fetches `/dev/player-ships` on mount. In the jsdom
 * test environment that fetch fails / is unmocked, so the panel renders
 * its empty state — but the testid container is still in the DOM, which
 * is what we assert.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GalaxyTab } from './GalaxyTab.js';
import { useUIStore } from '../../../state/store.js';

beforeEach(() => {
  // Reset Zustand to a known state. Fetch is left untouched (it'll fail
  // silently in jsdom; the panel's empty-state path is what we test).
  useUIStore.setState({
    drawerTab: 'galaxy',
    isDrawerOpen: true,
    transitState: 'DOCKED',
    currentSectorKey: 'sol-prime',
    arrivalMode: 'same',
    shipRoster: [],
    playerId: 'player-test',
  });
  // jsdom doesn't ship fetch; install a stub that returns an empty roster.
  // The panel calls fetch with a relative URL — we satisfy the contract
  // without making real requests.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ships: [] }),
    })),
  );
});

describe('GalaxyTab — Phase 5 roster mount', () => {
  it('mounts ShipRosterPanel alongside the existing arrival picker', () => {
    render(<GalaxyTab />);
    // Phase 5 — new mount point.
    expect(screen.getByTestId('ship-roster-panel')).toBeInTheDocument();
    // Regression — the existing arrival picker continues to render.
    expect(screen.getByTestId('arrival-mode-toggle')).toBeInTheDocument();
  });

  it('shows the galaxy-map button regardless of roster state', () => {
    render(<GalaxyTab />);
    expect(screen.getByTestId('galaxy-tab-show-map')).toBeInTheDocument();
  });
});
