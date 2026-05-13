/**
 * Phase 5 — roster-count badge next to the drawer toggle.
 *
 * Reads `shipRoster: ShipRosterEntry[]` from Zustand (already populated
 * by Phase 2 `SHIP_ROSTER` push). Renders a small chip with the count
 * vs `ROSTER_CAP`. Turns red at cap (10/10). Hidden / muted at 0/10 so
 * the affordance is discoverable but not loud.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store.js';
import { RosterCountBadge } from './RosterCountBadge.js';

function fakeRoster(n: number): ReturnType<typeof useUIStore.getState>['shipRoster'] {
  return Array.from({ length: n }, (_, i) => ({
    shipId: `ship-${i}`,
    kind: 'fighter',
    kindVersion: 1,
    health: 100,
    sectorKey: 'sol-prime',
    x: 0,
    y: 0,
    isActive: i === 0,
  }));
}

describe('RosterCountBadge', () => {
  beforeEach(() => {
    // Reset to a clean state before each test.
    useUIStore.setState({ shipRoster: [] });
  });

  it('renders the testid container regardless of count', () => {
    render(<RosterCountBadge />);
    expect(screen.getByTestId('roster-count-badge')).toBeInTheDocument();
  });

  it('shows N/10 when the roster has N entries', () => {
    useUIStore.setState({ shipRoster: fakeRoster(4) });
    render(<RosterCountBadge />);
    expect(screen.getByTestId('roster-count-badge')).toHaveTextContent('4/10');
  });

  it('shows 0/10 (muted) when the roster is empty', () => {
    useUIStore.setState({ shipRoster: [] });
    render(<RosterCountBadge />);
    const badge = screen.getByTestId('roster-count-badge');
    expect(badge).toHaveTextContent('0/10');
    // Muted state surfaced as a data attribute so styling can hook off it
    // without leaking CSS into the test assertion.
    expect(badge).toHaveAttribute('data-state', 'empty');
  });

  it('shows 10/10 and marks state=full when at cap', () => {
    useUIStore.setState({ shipRoster: fakeRoster(10) });
    render(<RosterCountBadge />);
    const badge = screen.getByTestId('roster-count-badge');
    expect(badge).toHaveTextContent('10/10');
    expect(badge).toHaveAttribute('data-state', 'full');
  });

  it('marks state=normal for in-between counts', () => {
    useUIStore.setState({ shipRoster: fakeRoster(3) });
    render(<RosterCountBadge />);
    expect(screen.getByTestId('roster-count-badge')).toHaveAttribute('data-state', 'normal');
  });
});
