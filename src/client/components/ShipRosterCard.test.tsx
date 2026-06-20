/**
 * Phase A coverage lock for [ShipRosterCard.tsx](./ShipRosterCard.tsx) —
 * the single roster row rendered in [ShipRosterPanel.tsx](./ShipRosterPanel.tsx).
 *
 * UNCOVERED prior to this spec — `GalaxyTab.roster.test.tsx` mounts the
 * panel but never asserts on the per-card contract.
 *
 * The card has two render variants (`compact: true|false`) plus
 * active-vs-inactive presentation. This file locks the contract every
 * other consumer depends on:
 *   - `data-testid="ship-roster-card-${shipId}"` exists in both variants.
 *   - `data-active="1"` iff the entry's `isActive === true`, else "0".
 *   - Health-bar fill width tracks `health / kind.maxHealth`.
 *   - Click fires `onClick`.
 *   - The grid `(gx, gy)` testid + the active dot chip are FULL-VARIANT
 *     ONLY — compact strips them.
 *
 * If any of these flip, every spec that pokes `[data-testid=...]` for a
 * roster card breaks, so the lock is high-value cheap insurance.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShipRosterCard, type RosterShipEntry } from './ShipRosterCard.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

function makeShip(overrides: Partial<RosterShipEntry> = {}): RosterShipEntry {
  return {
    shipId: 'ship-abc-123',
    kind: 'fighter', // maxHealth read from the live catalogue (Fighter)
    kindVersion: 1,
    health: 75,
    sectorKey: 'sol-prime',
    x: 1500,
    y: 2500,
    isActive: false,
    activeRoomId: null,
    expiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('ShipRosterCard — full variant', () => {
  it('renders the card root with stable testid + data-active="0" for stored ships', () => {
    const ship = makeShip({ isActive: false });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);

    const card = screen.getByTestId(`ship-roster-card-${ship.shipId}`);
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute('data-active', '0');
  });

  it('renders the active dot chip and data-active="1" when the ship is active', () => {
    const ship = makeShip({ isActive: true });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);

    const card = screen.getByTestId(`ship-roster-card-${ship.shipId}`);
    expect(card).toHaveAttribute('data-active', '1');
    // The active-pill chip is only rendered in the full-variant active branch.
    expect(screen.getByTestId(`ship-roster-active-${ship.shipId}`)).toBeInTheDocument();
  });

  it('does NOT render the active dot chip when ship is stored (isActive=false)', () => {
    const ship = makeShip({ isActive: false });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);
    expect(screen.queryByTestId(`ship-roster-active-${ship.shipId}`)).toBeNull();
  });

  it('renders the kind displayName (Fighter for the default catalogue entry)', () => {
    const ship = makeShip({ kind: 'fighter' });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);
    expect(screen.getByText('Fighter')).toBeInTheDocument();
  });

  it('renders the grid (gx,gy) testid with rounded coords from world x/y / GRID_CELL=500', () => {
    const ship = makeShip({ x: 1500, y: 2500 });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);
    // 1500 / 500 = 3; 2500 / 500 = 5.
    expect(screen.getByTestId(`ship-roster-grid-${ship.shipId}`)).toHaveTextContent('3,5');
  });

  it('health bar fill data-pct = round((health / kind.maxHealth) * 100)', () => {
    // Expected pct is derived from the LIVE catalogue (the same source the
    // component reads via getShipKind) so a kind retune updates both sides
    // together instead of re-breaking this lock. The contract under test is
    // "component looks up kind.maxHealth, applies round(), renders to the
    // fill testid" — not a frozen percentage. We assert via `data-pct`
    // rather than `style.width` because MUI's sx flows through an
    // Emotion-generated class, not inline style — jsdom can't compute it.
    const health = 75;
    const expectedPct = String(Math.round((health / getShipKind('fighter').maxHealth) * 100));
    const ship = makeShip({ kind: 'fighter', health });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);
    expect(screen.getByTestId('ship-roster-health-fill')).toHaveAttribute('data-pct', expectedPct);
  });

  it('clicking the card fires onClick once', () => {
    const onClick = vi.fn();
    const ship = makeShip();
    render(<ShipRosterCard ship={ship} compact={false} onClick={onClick} />);
    fireEvent.click(screen.getByTestId(`ship-roster-card-${ship.shipId}`));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('health-bar fill clamps to 0-100 when health is out of bounds', () => {
    // Sanity: negative health → 0 %; over-cap health → 100 %.
    const { rerender } = render(
      <ShipRosterCard ship={makeShip({ health: -5 })} compact={false} onClick={() => {}} />,
    );
    expect(screen.getByTestId('ship-roster-health-fill')).toHaveAttribute('data-pct', '0');
    rerender(<ShipRosterCard ship={makeShip({ health: 9999 })} compact={false} onClick={() => {}} />);
    expect(screen.getByTestId('ship-roster-health-fill')).toHaveAttribute('data-pct', '100');
  });
});

describe('ShipRosterCard — compact variant', () => {
  it('renders the card root with the same testid + data-active contract', () => {
    const ship = makeShip({ isActive: true });
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    const card = screen.getByTestId(`ship-roster-card-${ship.shipId}`);
    expect(card).toHaveAttribute('data-active', '1');
  });

  it('strips the grid (gx,gy) testid', () => {
    const ship = makeShip();
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    expect(screen.queryByTestId(`ship-roster-grid-${ship.shipId}`)).toBeNull();
  });

  it('strips the active-pill chip even when isActive', () => {
    const ship = makeShip({ isActive: true });
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    expect(screen.queryByTestId(`ship-roster-active-${ship.shipId}`)).toBeNull();
  });

  it('strips the kind displayName text', () => {
    const ship = makeShip({ kind: 'fighter' });
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    expect(screen.queryByText('Fighter')).toBeNull();
  });

  it('keeps the health-bar fill — still observable for HUD diagnostics', () => {
    const health = 40;
    const expectedPct = String(Math.round((health / getShipKind('fighter').maxHealth) * 100));
    const ship = makeShip({ kind: 'fighter', health });
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    expect(screen.getByTestId('ship-roster-health-fill')).toHaveAttribute('data-pct', expectedPct);
  });

  it('clicking the compact card fires onClick once', () => {
    const onClick = vi.fn();
    const ship = makeShip();
    render(<ShipRosterCard ship={ship} compact={true} onClick={onClick} />);
    fireEvent.click(screen.getByTestId(`ship-roster-card-${ship.shipId}`));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ShipRosterCard — public level badge (Phase 4 WS-B1)', () => {
  it('renders the level badge in the full variant when level > 1', () => {
    const ship = makeShip({ level: 4 });
    render(<ShipRosterCard ship={ship} compact={false} onClick={() => {}} />);
    const badge = screen.getByTestId('level-badge');
    expect(badge).toHaveAttribute('data-level', '4');
    expect(badge).toHaveTextContent('Lv 4');
  });

  it('renders the level badge in the compact variant when level > 1', () => {
    const ship = makeShip({ level: 6 });
    render(<ShipRosterCard ship={ship} compact={true} onClick={() => {}} />);
    expect(screen.getByTestId('level-badge')).toHaveTextContent('Lv 6');
  });

  it('omits the badge for an un-levelled (level 1 / absent) ship in both variants', () => {
    const { rerender } = render(
      <ShipRosterCard ship={makeShip({ level: 1 })} compact={false} onClick={() => {}} />,
    );
    expect(screen.queryByTestId('level-badge')).toBeNull();
    rerender(<ShipRosterCard ship={makeShip({ level: undefined })} compact={true} onClick={() => {}} />);
    expect(screen.queryByTestId('level-badge')).toBeNull();
  });
});
