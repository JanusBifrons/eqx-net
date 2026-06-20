/**
 * Phase 4 WS-B2 — the upgrade modal renders the stat pool, enforces the budget
 * affordance (remaining-points + disabled increments at the cap), and fires the
 * Apply / Respec callbacks with the canonical (zero-stripped) allocation. The
 * draft math is unit-locked in `upgradeModalDraft.test.ts`; this locks the React
 * wiring (rows, points readout, button gating).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpgradeModal } from './UpgradeModal';
import type { RosterShipEntry } from './ShipRosterCard';

function makeShip(over: Partial<RosterShipEntry> = {}): RosterShipEntry {
  return {
    shipId: 'ship-1',
    kind: 'fighter',
    kindVersion: 1,
    health: 100,
    sectorKey: 'sol-prime',
    x: 0,
    y: 0,
    isActive: true,
    activeRoomId: null,
    expiresAt: 0,
    createdAt: 0,
    updatedAt: 0,
    level: 6, // budget 5
    statAlloc: {},
    ...over,
  };
}

describe('UpgradeModal (Phase 4 WS-B2)', () => {
  it('renders a row for every stat in the pool', () => {
    render(<UpgradeModal ship={makeShip()} open onClose={() => {}} onApply={() => {}} onRespec={() => {}} />);
    for (const id of ['hull', 'energy', 'damage', 'topSpeed', 'turnRate', 'shield']) {
      expect(screen.getByTestId(`upgrade-row-${id}`)).toBeInTheDocument();
    }
  });

  it('shows the remaining / budget points for the ship level', () => {
    render(<UpgradeModal ship={makeShip({ level: 6 })} open onClose={() => {}} onApply={() => {}} onRespec={() => {}} />);
    const readout = screen.getByTestId('upgrade-points-remaining');
    expect(readout).toHaveAttribute('data-remaining', '5');
    expect(readout).toHaveAttribute('data-budget', '5');
  });

  it('incrementing a stat spends a point + enables Apply', () => {
    render(<UpgradeModal ship={makeShip()} open onClose={() => {}} onApply={() => {}} onRespec={() => {}} />);
    expect(screen.getByTestId('upgrade-apply')).toBeDisabled(); // clean draft
    fireEvent.click(screen.getByTestId('upgrade-inc-topSpeed'));
    expect(screen.getByTestId('upgrade-value-topSpeed')).toHaveAttribute('data-points', '1');
    expect(screen.getByTestId('upgrade-points-remaining')).toHaveAttribute('data-remaining', '4');
    expect(screen.getByTestId('upgrade-apply')).toBeEnabled();
  });

  it('the budget cannot be exceeded — increments disable at 0 remaining', () => {
    // Level 2 ⇒ budget 1. Spend it, then every increment is disabled.
    render(<UpgradeModal ship={makeShip({ level: 2 })} open onClose={() => {}} onApply={() => {}} onRespec={() => {}} />);
    fireEvent.click(screen.getByTestId('upgrade-inc-hull'));
    expect(screen.getByTestId('upgrade-points-remaining')).toHaveAttribute('data-remaining', '0');
    expect(screen.getByTestId('upgrade-inc-topSpeed')).toBeDisabled();
    expect(screen.getByTestId('upgrade-inc-hull')).toBeDisabled();
  });

  it('Apply fires with the canonical (zero-stripped) allocation', () => {
    const onApply = vi.fn();
    render(<UpgradeModal ship={makeShip()} open onClose={() => {}} onApply={onApply} onRespec={() => {}} />);
    fireEvent.click(screen.getByTestId('upgrade-inc-turnRate'));
    fireEvent.click(screen.getByTestId('upgrade-inc-turnRate'));
    fireEvent.click(screen.getByTestId('upgrade-apply'));
    expect(onApply).toHaveBeenCalledWith('ship-1', { turnRate: 2 });
  });

  it('Respec fires the respec callback', () => {
    const onRespec = vi.fn();
    render(
      <UpgradeModal
        ship={makeShip({ statAlloc: { damage: 3 } })}
        open
        onClose={() => {}}
        onApply={() => {}}
        onRespec={onRespec}
      />,
    );
    fireEvent.click(screen.getByTestId('upgrade-respec'));
    expect(onRespec).toHaveBeenCalledWith('ship-1');
  });

  it('seeds the draft from the ship’s current server allocation', () => {
    render(
      <UpgradeModal
        ship={makeShip({ statAlloc: { hull: 2 } })}
        open
        onClose={() => {}}
        onApply={() => {}}
        onRespec={() => {}}
      />,
    );
    expect(screen.getByTestId('upgrade-value-hull')).toHaveAttribute('data-points', '2');
    expect(screen.getByTestId('upgrade-points-remaining')).toHaveAttribute('data-remaining', '3'); // 5 - 2
  });
});

describe('UpgradeModal — dynamic weapon mounts (Phase 4 WS-B3)', () => {
  it('renders the catalogue latent mounts when onActivateMount is provided', () => {
    render(
      <UpgradeModal
        ship={makeShip()} open onClose={() => {}} onApply={() => {}} onRespec={() => {}}
        onActivateMount={() => {}}
      />,
    );
    // The fighter declares two latent wing hardpoints.
    expect(screen.getByTestId('upgrade-mounts')).toBeInTheDocument();
    expect(screen.getByTestId('mount-slot-latent-wing-l')).toBeInTheDocument();
    expect(screen.getByTestId('mount-slot-latent-wing-r')).toBeInTheDocument();
  });

  it('hides the mounts section when no onActivateMount is wired', () => {
    render(<UpgradeModal ship={makeShip()} open onClose={() => {}} onApply={() => {}} onRespec={() => {}} />);
    expect(screen.queryByTestId('upgrade-mounts')).not.toBeInTheDocument();
  });

  it('Activate fires onActivateMount with the slot + the picked weapon', () => {
    const onActivateMount = vi.fn();
    render(
      <UpgradeModal
        ship={makeShip()} open onClose={() => {}} onApply={() => {}} onRespec={() => {}}
        onActivateMount={onActivateMount}
      />,
    );
    // Pick the Beam (hitscan) weapon, then activate the left wing.
    fireEvent.click(screen.getByTestId('mount-weapon-hitscan'));
    fireEvent.click(screen.getByTestId('mount-activate-latent-wing-l'));
    expect(onActivateMount).toHaveBeenCalledWith('ship-1', 'latent-wing-l', 'hitscan');
  });

  it('an already-activated slot shows Active and no Activate button', () => {
    render(
      <UpgradeModal
        ship={makeShip({ mounts: [{ slotId: 'latent-wing-l', weaponId: 'laser' }] })}
        open onClose={() => {}} onApply={() => {}} onRespec={() => {}}
        onActivateMount={() => {}}
      />,
    );
    expect(screen.getByTestId('mount-slot-latent-wing-l')).toHaveAttribute('data-active', '1');
    expect(screen.queryByTestId('mount-activate-latent-wing-l')).not.toBeInTheDocument();
    // The other slot is still activatable.
    expect(screen.getByTestId('mount-activate-latent-wing-r')).toBeInTheDocument();
  });
});
