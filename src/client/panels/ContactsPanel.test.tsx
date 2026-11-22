/**
 * Contacts panel (UI plan U2-3): the rail's Contacts item and the O key open
 * it on the one `rightPanel` flag; ✕ and Esc close it. Rows show names, never
 * ids; a tap locks the row with the ACTIVE group through the same
 * `lock_request` sender the info box uses; a tap on a row the active group is
 * locking or has locked cancels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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

import { ContactsPanel } from './ContactsPanel';
import { useUIStore } from '../state/store';
import { pickRailItem } from '../layout/RightPanelHost';
import { installFcKeys } from '../input/MouseLock';

beforeEach(() => {
  requestLock.mockReset();
  cancelLock.mockReset();
  fakeMirror.localGroups[0]!.l = [];
  useUIStore.setState({
    rightPanel: 'contacts',
    activeGroupId: 'guns',
    fcGroups: [{ id: 'guns', name: 'Guns', mode: 'manual', colour: 0, capacity: 1, locks: [] }],
  });
});
afterEach(() => { cleanup(); useUIStore.setState({ rightPanel: null }); });

describe('ContactsPanel: opening and closing', () => {
  it('the rail pick opens it; a second pick closes it', () => {
    useUIStore.setState({ rightPanel: null });
    render(<ContactsPanel />);
    expect(screen.getByTestId('contacts-panel')).not.toBeVisible();
    act(() => pickRailItem('contacts', useUIStore.getState()));
    expect(useUIStore.getState().rightPanel).toBe('contacts');
    expect(screen.getByTestId('contacts-panel')).toBeVisible();
    act(() => pickRailItem('contacts', useUIStore.getState()));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('the O key toggles it, replacing another open panel', () => {
    useUIStore.setState({ rightPanel: 'galaxy' });
    const off = installFcKeys();
    try {
      act(() => { fireEvent.keyDown(window, { key: 'o', code: 'KeyO' }); });
      expect(useUIStore.getState().rightPanel).toBe('contacts');
      act(() => { fireEvent.keyDown(window, { key: 'o', code: 'KeyO' }); });
      expect(useUIStore.getState().rightPanel).toBeNull();
    } finally {
      off();
    }
  });

  it('✕ closes it', () => {
    render(<ContactsPanel />);
    fireEvent.click(screen.getByTestId('contacts-panel-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('Esc closes it', () => {
    render(<ContactsPanel />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(useUIStore.getState().rightPanel).toBeNull();
  });
});

describe('ContactsPanel: the list', () => {
  it('lists contacts by name (no ids), hostiles first, with km and reach', () => {
    render(<ContactsPanel />);
    const panel = screen.getByTestId('contacts-panel');
    expect(panel.textContent).toContain('Fighter');
    expect(panel.textContent).toContain('Heavy');
    expect(panel.textContent).toContain('Ripley');
    expect(panel.textContent).not.toContain(PLAYER_ID);
    expect(panel.textContent).not.toMatch(/s:\d|p:/);
    expect(panel.getAttribute('data-count')).toBe('3');
    const rows = panel.querySelectorAll('[data-testid^="contact-row-"]');
    expect(rows[0]!.getAttribute('data-key')).toBe('s:7'); // the hostile
    expect(rows[0]!.textContent).toContain('400 m');
    expect(rows[0]!.getAttribute('data-in-reach')).toBe('active');
    expect(screen.getByTestId('contact-row-s:8').getAttribute('data-in-reach')).toBe('none');
    expect(screen.getByTestId(`contact-row-p:${PLAYER_ID}`).textContent).toContain('3.0 km');
  });

  it('the sort switch puts the nearest first', () => {
    fakeMirror.swarm.set(7, { kind: 1, shipKind: 'fighter', x: 0, y: 2000, isHostileToLocal: true });
    try {
      render(<ContactsPanel />);
      const first = () => screen.getByTestId('contacts-panel').querySelector('[data-testid^="contact-row-"]')!.getAttribute('data-key');
      expect(first()).toBe('s:7');
      fireEvent.click(screen.getByTestId('contacts-sort-nearest'));
      expect(first()).toBe('s:8');
    } finally {
      fakeMirror.swarm.set(7, { kind: 1, shipKind: 'fighter', x: 0, y: 400, isHostileToLocal: true });
    }
  });

  it('a tap locks the row with the active group', () => {
    render(<ContactsPanel />);
    fireEvent.click(screen.getByTestId('contact-row-s:8'));
    expect(requestLock).toHaveBeenCalledWith('guns', 's:8');
    expect(cancelLock).not.toHaveBeenCalled();
  });

  it('a tap on a locked (or acquiring) row cancels that lock; it reads LOCKED', () => {
    fakeMirror.localGroups[0]!.l = [{ t: 's:7', s: 2, p: 100 }];
    render(<ContactsPanel />);
    const row = screen.getByTestId('contact-row-s:7');
    expect(row.getAttribute('data-lock')).toBe('locked');
    expect(row.textContent).toContain('LOCKED');
    fireEvent.click(row);
    expect(cancelLock).toHaveBeenCalledWith('guns', 's:7');
    expect(requestLock).not.toHaveBeenCalled();
  });

  it('acquiring shows a capped percent, and refreshes from the mirror while open', () => {
    vi.useFakeTimers();
    try {
      render(<ContactsPanel />);
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
});
