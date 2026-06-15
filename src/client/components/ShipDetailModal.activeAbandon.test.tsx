/**
 * Phase 5 — abandoning ANY ship from the detail modal is gated by a
 * confirm step (the action is destructive — hull shatters into scrap).
 * Abandoning the player's currently-active ship gets a STRONGER warning
 * ("ejects you to the galaxy map") so a tap-mistake doesn't kick them
 * out of gameplay.
 *
 * Both confirm dialogs are conditionally rendered so their testids
 * disappear from the DOM on Cancel — that's how the test asserts the
 * closed state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShipDetailModal } from './ShipDetailModal.js';
import type { RosterShipEntry } from './ShipRosterCard.js';
import { useUIStore } from '../state/store.js';

function makeShip(overrides: Partial<RosterShipEntry> = {}): RosterShipEntry {
  return {
    shipId: 'ship-test-1',
    kind: 'fighter',
    kindVersion: 1,
    health: 80,
    sectorKey: 'sol-prime',
    x: 100,
    y: -200,
    isActive: false,
    activeRoomId: null,
    expiresAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  // Default to galaxy-map context, no piloted ship. Per-test overrides
  // set `phase: 'game'` + `localShipInstanceId: '<id>'` to exercise the
  // in-game / piloting branches.
  useUIStore.setState({ phase: 'galaxy-map', localShipInstanceId: null });
});

describe('ShipDetailModal abandon flow', () => {
  it('stored ship: Abandon opens a confirm dialog (NOT immediate onAbandon)', () => {
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    // Standard confirm dialog appears.
    const confirm = screen.getByTestId('ship-detail-abandon-confirm');
    expect(confirm).toBeInTheDocument();
    // onAbandon NOT yet called — user must confirm.
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('stored ship: confirm fires onAbandon', () => {
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    fireEvent.click(screen.getByTestId('ship-detail-abandon-confirm-button'));
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onAbandon).toHaveBeenCalledWith(ship);
  });

  it('stored ship: cancel closes the dialog without abandoning', () => {
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    fireEvent.click(screen.getByTestId('ship-detail-abandon-cancel'));
    expect(onAbandon).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ship-detail-abandon-confirm')).toBeNull();
  });

  it('my piloted ship: Abandon shows a STRONGER second-tier confirm (no immediate call)', () => {
    // The "active ship" warning is now gated on `localShipInstanceId`
    // (THIS session's hull) — NOT the server-side `ship.isActive`, which
    // stays true through the 15-min linger window after disconnect.
    useUIStore.setState({ phase: 'game', localShipInstanceId: 'ship-test-1' });
    const ship = makeShip({ isActive: true, activeRoomId: 'room-abc' });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    const confirm = screen.getByTestId('ship-detail-abandon-active-confirm');
    expect(confirm).toBeInTheDocument();
    expect(confirm.textContent ?? '').toMatch(/active ship/i);
    expect(confirm.textContent ?? '').toMatch(/galaxy map/i);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('my piloted ship: Cancel on the active-confirm does NOT fire onAbandon', () => {
    useUIStore.setState({ phase: 'game', localShipInstanceId: 'ship-test-1' });
    const ship = makeShip({ isActive: true, activeRoomId: 'room-abc' });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    fireEvent.click(screen.getByTestId('ship-detail-abandon-active-cancel'));
    expect(onAbandon).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ship-detail-abandon-active-confirm')).toBeNull();
  });

  it('my piloted ship: Confirm on the active-confirm fires onAbandon exactly once', () => {
    useUIStore.setState({ phase: 'game', localShipInstanceId: 'ship-test-1' });
    const ship = makeShip({ isActive: true, activeRoomId: 'room-abc' });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    fireEvent.click(screen.getByTestId('ship-detail-abandon-active-confirm-button'));
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onAbandon).toHaveBeenCalledWith(ship);
  });

  it('regression: server-side isActive ship that is NOT THIS session\'s pilot gets the normal abandon confirm', () => {
    // Roster card marked `isActive=true` from the linger window of a
    // previous session. The local browser is in 'game' but piloting a
    // DIFFERENT hull. Abandon should show the normal (non-strong)
    // confirm — the user isn't ejected because this hull isn't theirs.
    useUIStore.setState({ phase: 'game', localShipInstanceId: 'some-other-ship' });
    const ship = makeShip({
      shipId: 'ship-test-1',
      isActive: true,
      activeRoomId: 'room-abc',
    });
    const onAbandon = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={() => {}}
        onAbandon={onAbandon}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-abandon'));
    expect(screen.getByTestId('ship-detail-abandon-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('ship-detail-abandon-active-confirm')).toBeNull();
  });
});

describe('ShipDetailModal spawn flow — switch confirm', () => {
  it('galaxy-map context: Spawn fires onSpawn immediately (no confirm)', () => {
    useUIStore.setState({ phase: 'galaxy-map' });
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onSpawn = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-spawn'));
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('ship-detail-switch-confirm')).toBeNull();
  });

  it('in-game context: Spawn on a non-active ship shows the switch-confirm', () => {
    useUIStore.setState({ phase: 'game' });
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onSpawn = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-spawn'));
    const confirm = screen.getByTestId('ship-detail-switch-confirm');
    expect(confirm).toBeInTheDocument();
    expect(confirm.textContent ?? '').toMatch(/parked/i);
    // No spawn yet — user must confirm.
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('in-game context: Confirm-Switch fires onSpawn', () => {
    useUIStore.setState({ phase: 'game' });
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onSpawn = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-spawn'));
    fireEvent.click(screen.getByTestId('ship-detail-switch-confirm-button'));
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith(ship);
  });

  it('in-game context: Cancel-Switch does NOT fire onSpawn', () => {
    useUIStore.setState({ phase: 'game' });
    const ship = makeShip({ isActive: false, activeRoomId: null });
    const onSpawn = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('ship-detail-spawn'));
    fireEvent.click(screen.getByTestId('ship-detail-switch-cancel'));
    expect(onSpawn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ship-detail-switch-confirm')).toBeNull();
  });

  it('the ship THIS session pilots shows "Piloting" disabled (not "Spawn")', () => {
    useUIStore.setState({ phase: 'game', localShipInstanceId: 'ship-test-1' });
    const ship = makeShip({ shipId: 'ship-test-1', isActive: true, activeRoomId: 'room-abc' });
    const onSpawn = vi.fn();
    const onClose = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={onClose}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    const btn = screen.getByTestId('ship-detail-spawn');
    expect(btn).toBeDisabled();
    expect(btn.textContent ?? '').toMatch(/piloting/i);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('regression: a server-side isActive ship that is NOT this session\'s pilot still shows "Spawn"', () => {
    // The bug we just fixed: post-refresh, the roster's ships all carry
    // `isActive=true` from their pre-refresh 15-min linger; the modal
    // must NOT mark them all as "Piloting".
    useUIStore.setState({ phase: 'galaxy-map', localShipInstanceId: null });
    const ship = makeShip({ shipId: 'ship-foo', isActive: true, activeRoomId: 'room-prev' });
    const onSpawn = vi.fn();
    render(
      <ShipDetailModal
        ship={ship}
        open={true}
        onClose={() => {}}
        onSpawn={onSpawn}
        onAbandon={() => {}}
      />,
    );
    const btn = screen.getByTestId('ship-detail-spawn');
    expect(btn).not.toBeDisabled();
    expect(btn.textContent ?? '').toMatch(/spawn/i);
    fireEvent.click(btn);
    // On the post-auth galaxy-map (phase != 'game'), Spawn fires directly
    // without the switch-confirm.
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });
});
