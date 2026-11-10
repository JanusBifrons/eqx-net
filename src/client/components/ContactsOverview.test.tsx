/**
 * Contacts overview (component): rows show names, never ids; a tap locks the
 * row with the ACTIVE group through the same `lock_request` sender the info
 * box uses; a tap on a row the active group is locking or has locked cancels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const PLAYER_ID = '0a1b2c3d-4e5f-4000-8000-000000000001';
const requestLock = vi.fn();
const cancelLock = vi.fn();
const fakeMirror = {
  localPlayerId: 'me',
  ships: new Map<string, unknown>([
    ['me', { x: 0, y: 0, kind: 'fighter' }],
    [PLAYER_ID, { x: 0, y: -3000, kind: 'fighter', displayName: 'Ripley' }],
  ]),
  swarm: new Map<number, unknown>([
    [7, { kind: 1, shipKind: 'fighter', x: 0, y: 400, isHostileToLocal: true }],
    [8, { kind: 1, shipKind: 'heavy', x: 1500, y: 0 }],
  ]),
  structures: new Map(),
  localGroups: [{ id: 'guns', m: 1, l: [] as Array<{ t: string; s: number; p: number }> }],
  localLockedBy: [] as Array<{ t: string; s: number; p: number }>,
};
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ mirror: fakeMirror, requestLock, cancelLock, fcGroupReach: () => 600 }),
}));

import { ContactsOverview } from './ContactsOverview';
import { useUIStore } from '../state/store';

beforeEach(() => {
  requestLock.mockReset();
  cancelLock.mockReset();
  fakeMirror.localGroups[0]!.l = [];
  useUIStore.setState({
    contactsOpen: true,
    activeGroupId: 'guns',
    fcGroups: [{ id: 'guns', name: 'Guns', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
  });
});
afterEach(() => { useUIStore.setState({ contactsOpen: false }); });

describe('ContactsOverview', () => {
  it('lists contacts by name (no ids), hostiles first, with km and reach', () => {
    render(<ContactsOverview />);
    const panel = screen.getByTestId('contacts-panel');
    expect(panel.textContent).toContain('Fighter');
    expect(panel.textContent).toContain('Heavy');
    expect(panel.textContent).toContain('Ripley');
    expect(panel.textContent).not.toContain(PLAYER_ID);
    expect(panel.textContent).not.toMatch(/s:\d|p:/);
    const rows = panel.querySelectorAll('[data-testid^="contact-row-"]');
    expect(rows[0]!.getAttribute('data-key')).toBe('s:7'); // the hostile
    expect(rows[0]!.textContent).toContain('400 m');
    expect(rows[0]!.getAttribute('data-in-reach')).toBe('active');
    expect(screen.getByTestId('contact-row-s:8').getAttribute('data-in-reach')).toBe('none');
    expect(screen.getByTestId(`contact-row-p:${PLAYER_ID}`).textContent).toContain('3.0 km');
  });

  it('a tap locks the row with the active group', () => {
    render(<ContactsOverview />);
    fireEvent.click(screen.getByTestId('contact-row-s:8'));
    expect(requestLock).toHaveBeenCalledWith('guns', 's:8');
    expect(cancelLock).not.toHaveBeenCalled();
  });

  it('a tap on a locked (or acquiring) row cancels that lock', () => {
    fakeMirror.localGroups[0]!.l = [{ t: 's:7', s: 2, p: 100 }];
    render(<ContactsOverview />);
    const row = screen.getByTestId('contact-row-s:7');
    expect(row.getAttribute('data-lock')).toBe('locked');
    fireEvent.click(row);
    expect(cancelLock).toHaveBeenCalledWith('guns', 's:7');
    expect(requestLock).not.toHaveBeenCalled();
  });

  it('acquiring shows a capped percent, and refreshes from the mirror while open', () => {
    vi.useFakeTimers();
    try {
      render(<ContactsOverview />);
      expect(screen.getByTestId('contact-row-s:8').getAttribute('data-lock')).toBe('none');
      fakeMirror.localGroups[0]!.l = [{ t: 's:8', s: 1, p: 99.7 }];
      act(() => { vi.advanceTimersByTime(300); });
      const row = screen.getByTestId('contact-row-s:8');
      expect(row.getAttribute('data-lock')).toBe('acquiring');
      expect(row.textContent).toContain('99%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the closed tab shows no "(0)"-like count; the O shortcut is a tooltip, not label text', () => {
    // Bug (2026-11-10 showcase): the closed tab read "CONTACTS (O)", the O
    // hotkey hint, which reads as a zero count ("CONTACTS (0)") while closed.
    useUIStore.setState({ contactsOpen: false });
    render(<ContactsOverview />);
    const tab = screen.getByTestId('contacts-toggle');
    expect(tab.textContent).toContain('CONTACTS');
    expect(tab.textContent).not.toMatch(/\(\s*[0-9O]+\s*\)/);
    expect(tab.getAttribute('aria-keyshortcuts')).toBe('O');
  });

  it('the toggle opens and closes the panel', () => {
    useUIStore.setState({ contactsOpen: false });
    render(<ContactsOverview />);
    expect(screen.queryByTestId('contacts-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('contacts-toggle'));
    expect(screen.getByTestId('contacts-panel')).toBeTruthy();
    expect(useUIStore.getState().contactsOpen).toBe(true);
  });
});
