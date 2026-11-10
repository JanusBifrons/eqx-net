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

  // Frame review 2026-11-10 (pack-battle primary_card_zoom, capital-guns-fighter
  // c010): a fixed 58 px chip clipped "PRIMARY" + its group number under the
  // right border ("PRIMARY1", the 1 half cut off). jsdom has no layout, so lock
  // the CSS that guarantees the fit: the chip grows with its label (min width
  // only), the name never wraps, and the number never shrinks and keeps a gap.
  it('a long group name never clips its group number', () => {
    useUIStore.getState().setFcGroups([
      { id: 'primary', name: 'Primary', mode: 'auto', colour: 0, capacity: 1, locks: [{ target: 's:4', stage: 1 }] },
    ]);
    render(<WeaponStrip />);
    const chip = screen.getByTestId('fc-chip-primary');
    expect(chip.style.width).toBe('');
    expect(chip.style.minWidth).not.toBe('');
    const num = screen.getByTestId('fc-num-primary');
    expect(num.textContent).toBe('1');
    expect(num.style.flexShrink).toBe('0');
    const row = num.parentElement!;
    expect(row.style.whiteSpace).toBe('nowrap');
    expect(parseFloat(row.style.gap)).toBeGreaterThan(0);
  });

  it('mode pill toggles; × drops the group locks', () => {
    render(<WeaponStrip />);
    fireEvent.pointerDown(screen.getByTestId('fc-mode-fore'));
    expect(client.setGroupMode).toHaveBeenCalledWith('fore', 'manual');
    fireEvent.pointerDown(screen.getByTestId('fc-clear-fore'));
    expect(client.cancelLock).toHaveBeenCalledWith('fore');
  });
});
