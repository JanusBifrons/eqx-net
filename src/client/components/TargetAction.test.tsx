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

import { TargetAction } from './TargetAction';

/**
 * User report (1v3 clip, 2026-11-08): LOCK in the info box "did nothing". The
 * target was out of reach, so the lock sat at 0 % and dropped after the grace
 * with no feedback. The server now marks such a lock `blocked`; the button must
 * say so.
 */
function setLock(lock: { target: string; stage: number; blocked?: boolean } | null): void {
  useUIStore.setState({
    selectedEntityKind: 'drone',
    selectedEntityId: 'swarm-7',
    activeGroupId: 'primary',
    fcGroups: [{ id: 'primary', name: 'Primary', mode: 'manual', colour: 0, capacity: 1, locks: lock ? [lock] : [] }],
  });
}

describe('TargetAction', () => {
  beforeEach(() => { cancelLock.mockReset(); lockSelected.mockReset(); });

  it('shows LOCK with no lock, and asks for one on tap', () => {
    setLock(null);
    render(<TargetAction isOwn={false} />);
    const btn = screen.getByTestId('fc-target');
    expect(btn.getAttribute('data-state')).toBe('lock');
    fireEvent.click(btn);
    expect(lockSelected).toHaveBeenCalledOnce();
  });

  it('shows OUT OF RANGE for a lock the server cannot progress; a tap cancels it', () => {
    setLock({ target: 's:7', stage: 1, blocked: true });
    render(<TargetAction isOwn={false} />);
    const btn = screen.getByTestId('fc-target');
    expect(btn.getAttribute('data-state')).toBe('blocked');
    expect(btn.textContent).toBe('OUT OF RANGE');
    fireEvent.click(btn);
    expect(cancelLock).toHaveBeenCalledWith('primary', 's:7');
  });

  it('shows CANCEL LOCK while a reachable lock builds', () => {
    setLock({ target: 's:7', stage: 1 });
    render(<TargetAction isOwn={false} />);
    expect(screen.getByTestId('fc-target').getAttribute('data-state')).toBe('cancel');
  });
});
