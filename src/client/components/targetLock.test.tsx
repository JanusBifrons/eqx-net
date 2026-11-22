import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store';

const cancelLock = vi.fn();
const lockSelected = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: 'me' },
    cancelLock,
    lockSelected,
  }),
}));

import { fleetLockApplies, lockFocus, useTargetLock } from './targetLock';
/** The hook drawn as a bare button (the strip draws it as an EqxIconButton: selectionStripItems.test.tsx). */
/** The hook drawn as a bare button (the strip draws it as an EqxIconButton, ). */
function TargetAction({ isOwn }: { isOwn: boolean }): JSX.Element | null {
  const t = useTargetLock(isOwn);
  return t === null ? null : <button data-testid="fc-target" data-state={t.state} onClick={t.onClick}>{t.tooltip}</button>;
}

/**
 * User report (1v3 clip, 2026-11-08): LOCK in the info box "did nothing". The
 * lock could not progress (out of lock range, or an untrackable target), so it
 * sat at 0 % and dropped after the grace
 * with no feedback. The server now marks such a lock `blocked`; the button must
 * say so.
 */
function setLock(lock: { target: string; stage: number; blocked?: boolean } | null): void {
  useUIStore.setState({
    selection: { ids: [], focusId: 'swarm-7', focusKind: 'drone' },
    activeGroupId: 'primary',
    fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: lock ? [lock] : [] }],
  });
}

describe('useTargetLock', () => {
  beforeEach(() => { cancelLock.mockReset(); lockSelected.mockReset(); });

  it('shows LOCK with no lock, and asks for one on tap', () => {
    setLock(null);
    render(<TargetAction isOwn={false} />);
    const btn = screen.getByTestId('fc-target');
    expect(btn.getAttribute('data-state')).toBe('lock');
    fireEvent.click(btn);
    expect(lockSelected).toHaveBeenCalledOnce();
  });

  it("says Can't track for a lock the server cannot progress (untrackable or past lock range); a tap cancels it", () => {
    setLock({ target: 's:7', stage: 1, blocked: true });
    render(<TargetAction isOwn={false} />);
    const btn = screen.getByTestId('fc-target');
    expect(btn.getAttribute('data-state')).toBe('blocked');
    expect(btn.textContent).toBe("Can't track: cancel lock");
    fireEvent.click(btn);
    expect(cancelLock).toHaveBeenCalledWith('primary', 's:7');
  });

  it('another player\'s AI-flown ship (a lingering selection) shows LOCK keyed p:<shipInstanceId>; your own does not', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    useUIStore.setState({
      selection: { ids: [], focusId: sid, focusKind: 'lingering' },
      activeGroupId: 'primary',
      fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: [{ target: `p:${sid}`, stage: 2 }] }],
    });
    const { unmount } = render(<TargetAction isOwn={false} />);
    expect(screen.getByTestId('fc-target').getAttribute('data-state')).toBe('unlock');
    unmount();
    render(<TargetAction isOwn />);
    expect(screen.queryByTestId('fc-target')).toBeNull();
  });

  it('shows CANCEL LOCK while a reachable lock builds', () => {
    setLock({ target: 's:7', stage: 1 });
    render(<TargetAction isOwn={false} />);
    expect(screen.getByTestId('fc-target').getAttribute('data-state')).toBe('cancel');
  });

  // Phone report 2026-11-21: a tapped rock showed "Asteroid / SIZE 36" but no
  // LOCK, so a miner could only lock it by holding the lock line ~8 s. Rocks
  // lock with the hands-off LOCK like a ship, keyed s:<swarmId> (same key the
  // lock line uses for terrain).
  it('a selected rock shows Lock · <group>; a tap asks for the lock; a built lock shows UNLOCK keyed s:<id>', () => {
    useUIStore.setState({
      selection: { ids: [], focusId: 'swarm-42', focusKind: 'asteroid' },
      activeGroupId: 'mining',
      fcGroups: [{ id: 'mining', name: 'Mining', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
    });
    const { unmount } = render(<TargetAction isOwn={false} />);
    const btn = screen.getByTestId('fc-target');
    expect(btn.getAttribute('data-state')).toBe('lock');
    expect(btn.textContent).toBe('Lock · Mining');
    fireEvent.click(btn);
    expect(lockSelected).toHaveBeenCalledOnce();
    unmount();
    useUIStore.setState({
      fcGroups: [{ id: 'mining', name: 'Mining', mode: 'manual', colour: 0, capacity: 1, locks: [{ target: 's:42', stage: 2 }] }],
    });
    render(<TargetAction isOwn={false} />);
    const un = screen.getByTestId('fc-target');
    expect(un.getAttribute('data-state')).toBe('unlock');
    fireEvent.click(un);
    expect(cancelLock).toHaveBeenCalledWith('mining', 's:42');
  });
});

/**
 * Tap rule T2 (UI plan D10): ONE Lock. With my ships selected and a focus
 * that is not mine and can be attacked (ship, parked hull, drone, structure),
 * Lock orders the ships to attack it (the renderer's `attackFocus`, the
 * right-click path). Otherwise it is today's personal lock with the active
 * weapon group: no ships selected, or a rock / pod.
 */
describe('fleetLockApplies', () => {
  it('ships selected + a not-mine attackable focus: the fleet Lock', () => {
    for (const k of ['ship', 'lingering', 'drone', 'structure'] as const) {
      expect(fleetLockApplies({ ids: ['a', 'b'], focusId: 'x', focusKind: k })).toBe(true);
    }
  });
  it('no ships, a rock or pod, no focus, or the focus is one of the selected ships: not the fleet Lock', () => {
    expect(fleetLockApplies({ ids: [], focusId: 'p2', focusKind: 'ship' })).toBe(false);
    expect(fleetLockApplies({ ids: ['a'], focusId: 'swarm-4', focusKind: 'asteroid' })).toBe(false);
    expect(fleetLockApplies({ ids: ['a'], focusId: 'swarm-5', focusKind: 'pod' })).toBe(false);
    expect(fleetLockApplies({ ids: ['a'], focusId: null, focusKind: null })).toBe(false);
    expect(fleetLockApplies({ ids: ['a', 'b'], focusId: 'a', focusKind: 'ship' })).toBe(false);
  });
});

describe('lockFocus (the strip Lock and the T key)', () => {
  it('fleet Lock: asks the renderer to attack the focus, never the personal lock', () => {
    const attackFocus = vi.fn();
    const personal = vi.fn(() => true);
    expect(lockFocus({ ids: ['a'], focusId: 'swarm-7', focusKind: 'drone' }, { attackFocus }, personal)).toBe(true);
    expect(attackFocus).toHaveBeenCalledOnce();
    expect(personal).not.toHaveBeenCalled();
  });
  it('no ships selected, or a rock: the personal lock', () => {
    const attackFocus = vi.fn();
    const personal = vi.fn(() => true);
    expect(lockFocus({ ids: [], focusId: 'p2', focusKind: 'ship' }, { attackFocus }, personal)).toBe(true);
    expect(lockFocus({ ids: ['a'], focusId: 'swarm-4', focusKind: 'asteroid' }, { attackFocus }, personal)).toBe(true);
    expect(personal).toHaveBeenCalledTimes(2);
    expect(attackFocus).not.toHaveBeenCalled();
  });
  it('fleet Lock with no renderer yet: nothing happens (false)', () => {
    const personal = vi.fn(() => true);
    expect(lockFocus({ ids: ['a'], focusId: 'p2', focusKind: 'ship' }, null, personal)).toBe(false);
    expect(personal).not.toHaveBeenCalled();
  });
});
