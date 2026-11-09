import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../state/store';

const client = { setGroupMode: vi.fn(), setGroupHeld: vi.fn(), cancelLock: vi.fn() };
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => client }));

import { WeaponStrip } from './WeaponStrip';

describe('WeaponStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.getState().setFcGroups([
      { id: 'fore', name: 'Fore', mode: 'auto', colour: 0, capacity: 1, locks: [{ target: 's:4', stage: 2 }] },
      { id: 'aft', name: 'Aft', mode: 'manual', colour: 1, capacity: 1, locks: [] },
    ]);
    useUIStore.getState().setActiveGroupId('fore');
  });

  it('renders a chip per group with lock + mode state', () => {
    render(<WeaponStrip />);
    expect(screen.getByTestId('fc-chip-fore').dataset.locked).toBe('1');
    expect(screen.getByTestId('fc-chip-fore').dataset.active).toBe('1');
    expect(screen.getByTestId('fc-mode-aft').dataset.state).toBe('manual');
    expect(screen.queryByTestId('fc-clear-aft')).toBeNull();
  });

  it('tapping a chip makes it active; holding a MAN chip fires it', () => {
    render(<WeaponStrip />);
    fireEvent.pointerDown(screen.getByTestId('fc-chip-aft'), { pointerId: 1 });
    expect(useUIStore.getState().activeGroupId).toBe('aft');
    expect(client.setGroupHeld).toHaveBeenCalledWith('aft');
    fireEvent.pointerUp(screen.getByTestId('fc-chip-aft'), { pointerId: 1 });
    expect(client.setGroupHeld).toHaveBeenLastCalledWith(null);
  });

  it('mode pill toggles; × drops the group locks', () => {
    render(<WeaponStrip />);
    fireEvent.pointerDown(screen.getByTestId('fc-mode-fore'));
    expect(client.setGroupMode).toHaveBeenCalledWith('fore', 'manual');
    fireEvent.pointerDown(screen.getByTestId('fc-clear-fore'));
    expect(client.cancelLock).toHaveBeenCalledWith('fore');
  });
});
