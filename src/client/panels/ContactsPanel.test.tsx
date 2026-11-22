/**
 * Contacts panel (UI plan U2-3): the rail's Contacts item and the O key open
 * it on the one `rightPanel` flag; ✕ and Esc close it. Rows show names, never
 * ids; a tap SELECTS the row's entity (the renderer focus, like a map tap;
 * owner: "it's never tap to lock") and closes the panel so the left strip's
 * Details / Lock icons show. Columns: Name, Type (icon), Faction (badge),
 * Distance; no Stance or Lock column (the row colour and wash say those).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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
  fakeMirror.localLockedBy = [];
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

const rowKeys = (): string[] => [...screen.getByTestId('contacts-panel').querySelectorAll('[data-testid^="contact-row-"]')]
  .map((r) => r.getAttribute('data-key')!);

describe('ContactsPanel: the table', () => {
  it('lists contacts by name (no ids), nearest first, with type, faction, km and reach', () => {
    render(<ContactsPanel />);
    const panel = screen.getByTestId('contacts-panel');
    expect(panel.textContent).toContain('Fighter');
    expect(panel.textContent).toContain('Heavy');
    expect(within(panel).getByRole('img', { name: 'Ripley' })).toBeTruthy(); // the pilot, the Faction badge's name
    expect(panel.textContent).not.toContain(PLAYER_ID);
    expect(panel.textContent).not.toMatch(/s:\d|p:/);
    expect(panel.getAttribute('data-count')).toBe('3');
    expect(rowKeys()).toEqual(['s:7', 's:8', `p:${PLAYER_ID}`]);
    const hostile = screen.getByTestId('contact-row-s:7');
    expect(hostile.textContent).toContain('400 m');
    expect(within(hostile).getByRole('img', { name: 'Drones' })).toBeTruthy();
    expect(hostile.getAttribute('data-in-reach')).toBe('active');
    expect(hostile.getAttribute('data-stance')).toBe('hostile');
    expect(screen.getByTestId('contact-row-s:8').getAttribute('data-in-reach')).toBe('none');
    const pilot = screen.getByTestId(`contact-row-p:${PLAYER_ID}`);
    expect(pilot.textContent).toContain('3.0 km');
    expect(pilot.getAttribute('data-faction')).toBe('Ripley');
    expect(pilot.getAttribute('data-type')).toBe('ship');
  });

  it('columns: Name, Type, Faction, Dist; no Stance or Lock column', () => {
    render(<ContactsPanel />);
    const heads = within(screen.getByTestId('contacts-list')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Name', 'Type', 'Faction', 'Dist▲']);
    expect(screen.queryByTestId('contacts-list-sort-stance')).toBeNull();
    expect(screen.queryByTestId('contacts-list-sort-lock')).toBeNull();
  });

  it('type is an icon named for its type; faction a badge in the faction colour, named for it', () => {
    render(<ContactsPanel />);
    const cells = within(screen.getByTestId('contact-row-s:7')).getAllByRole('cell');
    const typeIcon = cells[1]!.querySelector('svg')!;
    expect(typeIcon.getAttribute('data-icon')).toBe('ship');
    expect(typeIcon.getAttribute('aria-label')).toBe('Ship');
    const badge = within(cells[2]!).getByTestId('contact-faction');
    expect(badge.getAttribute('aria-label')).toBe('Drones');
    expect(badge.getAttribute('title')).toBe('Drones');
    expect(badge.textContent).toBe('D');
    expect(getComputedStyle(badge).backgroundColor).toBe('rgb(255, 68, 68)'); // the Drones colour, 0xff4444
    // No stance word in the row: the colour says it.
    expect(screen.getByTestId('contact-row-s:7').textContent).not.toContain('Hostile');
  });

  it('row text is the stance colour: hostile red, neutral the normal ink, friendly green', () => {
    render(<ContactsPanel />);
    expect(getComputedStyle(screen.getByTestId('contact-row-s:7')).color).toBe('rgb(255, 107, 107)');
    expect(getComputedStyle(screen.getByTestId('contact-row-s:8')).color).toBe('rgb(223, 232, 245)');
    expect(getComputedStyle(screen.getByTestId(`contact-row-p:${PLAYER_ID}`)).color).toBe('rgb(107, 255, 155)');
  });

  it('a header tap sorts by it; a second tap reverses; the previous column breaks ties', () => {
    render(<ContactsPanel />);
    expect(screen.getByTestId('contacts-list-sort-dist').getAttribute('data-sorted')).toBe('asc');
    fireEvent.click(screen.getByTestId('contacts-list-sort-dist'));
    expect(rowKeys()).toEqual([`p:${PLAYER_ID}`, 's:8', 's:7']);
    fireEvent.click(screen.getByTestId('contacts-list-sort-faction'));
    // Drones (s:8 before s:7: the old primary, farthest first), then Ripley.
    expect(rowKeys()).toEqual(['s:8', 's:7', `p:${PLAYER_ID}`]);
    expect(screen.getByTestId('contacts-list-sort-faction').getAttribute('data-sorted')).toBe('asc');
    fireEvent.click(screen.getByTestId('contacts-list-sort-faction'));
    expect(rowKeys()).toEqual([`p:${PLAYER_ID}`, 's:8', 's:7']);
  });

  it('the sort survives the 4 Hz refresh', () => {
    vi.useFakeTimers();
    try {
      render(<ContactsPanel />);
      fireEvent.click(screen.getByTestId('contacts-list-sort-dist'));
      fakeMirror.localGroups[0]!.l = [{ t: 's:8', s: 1, p: 50 }];
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.getByTestId('contact-row-s:8').getAttribute('data-lock')).toBe('acquiring');
      expect(rowKeys()).toEqual([`p:${PLAYER_ID}`, 's:8', 's:7']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters hide behind the toggle; type and stance filters narrow the table', () => {
    render(<ContactsPanel />);
    expect(screen.queryByTestId('contacts-filters')).toBeNull();
    fireEvent.click(screen.getByTestId('contacts-filters-toggle'));
    expect(screen.getByTestId('contacts-filters')).toBeTruthy();
    fireEvent.click(screen.getByTestId('contacts-filter-stance-friendly'));
    expect(rowKeys()).toEqual([`p:${PLAYER_ID}`]);
    expect(screen.getByTestId('contacts-panel').getAttribute('data-count')).toBe('1');
    fireEvent.click(screen.getByTestId('contacts-filter-stance-all'));
    fireEvent.click(screen.getByTestId('contacts-filter-type-structure'));
    expect(rowKeys()).toEqual([]);
    expect(screen.getByTestId('contacts-empty')).toHaveTextContent('No contacts match the filters');
    // Hiding the filters keeps them applied (the toggle stays lit).
    fireEvent.click(screen.getByTestId('contacts-filters-toggle'));
    expect(screen.queryByTestId('contacts-filters')).toBeNull();
    expect(rowKeys()).toEqual([]);
  });

  it('the faction filter lists the factions present', () => {
    render(<ContactsPanel />);
    fireEvent.click(screen.getByTestId('contacts-filters-toggle'));
    fireEvent.mouseDown(within(screen.getByTestId('contacts-filter-faction')).getByRole('combobox'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['All factions', 'Drones', 'Ripley']);
    fireEvent.click(screen.getByRole('option', { name: 'Ripley' }));
    expect(rowKeys()).toEqual([`p:${PLAYER_ID}`]);
  });

  it('pages: 8 rows a page; arrows and numbered page buttons', () => {
    for (let i = 0; i < 10; i++) fakeMirror.swarm.set(100 + i, { kind: 1, shipKind: 'fighter', x: 5000 + i * 10, y: 0 });
    try {
      render(<ContactsPanel />);
      expect(screen.getByTestId('contacts-panel').getAttribute('data-count')).toBe('13');
      expect(rowKeys()).toHaveLength(8);
      const page = (): string | null => screen.getByTestId('contacts-list-page').getAttribute('data-page');
      expect(page()).toBe('0');
      expect(screen.getByTestId('contacts-list-page').getAttribute('data-pages')).toBe('2');
      expect(screen.getByTestId('contacts-list-prev').getAttribute('aria-label')).toBe('Previous page');
      fireEvent.click(screen.getByTestId('contacts-list-next'));
      expect(rowKeys()).toHaveLength(5);
      expect(page()).toBe('1');
      expect(screen.getByTestId('contacts-list-page-2').getAttribute('aria-current')).toBe('page');
      fireEvent.click(screen.getByTestId('contacts-list-page-1'));
      expect(page()).toBe('0');
      fireEvent.click(screen.getByTestId('contacts-list-page-2'));
      // A sort change goes back to page 1.
      fireEvent.click(screen.getByTestId('contacts-list-sort-name'));
      expect(page()).toBe('0');
    } finally {
      for (let i = 0; i < 10; i++) fakeMirror.swarm.delete(100 + i);
    }
  });

  it('no contacts: an empty line', () => {
    const saved = new Map(fakeMirror.swarm);
    const savedPilot = fakeMirror.ships.get(PLAYER_ID);
    fakeMirror.swarm.clear();
    fakeMirror.ships.delete(PLAYER_ID);
    try {
      render(<ContactsPanel />);
      expect(screen.getByTestId('contacts-empty')).toHaveTextContent('Nothing to lock nearby');
    } finally {
      saved.forEach((v, k) => fakeMirror.swarm.set(k, v));
      fakeMirror.ships.set(PLAYER_ID, savedPilot);
    }
  });

  it('a tap SELECTS the row (never locks): the renderer focuses it and the panel closes', () => {
    const focusEntity = vi.fn();
    render(<ContactsPanel rendererRef={{ current: { focusEntity } }} />);
    fireEvent.click(screen.getByTestId('contact-row-s:8'));
    expect(requestLock).not.toHaveBeenCalled();
    expect(cancelLock).not.toHaveBeenCalled();
    expect(focusEntity).toHaveBeenCalledWith('swarm-8', 'drone');
    expect(useUIStore.getState().rightPanel).toBeNull(); // the strip and the entity show
  });

  it('a tap on a locked row selects it too (no unlock); the lock shows in its data attrs', () => {
    fakeMirror.localGroups[0]!.l = [{ t: 's:7', s: 2, p: 100 }];
    const focusEntity = vi.fn();
    render(<ContactsPanel rendererRef={{ current: { focusEntity } }} />);
    const row = screen.getByTestId('contact-row-s:7');
    expect(row.getAttribute('data-lock')).toBe('locked');
    fireEvent.click(row);
    expect(cancelLock).not.toHaveBeenCalled();
    expect(requestLock).not.toHaveBeenCalled();
    expect(focusEntity).toHaveBeenCalledWith('swarm-7', 'drone');
  });

  it('a player ship row focuses its mirror key as a ship', () => {
    const focusEntity = vi.fn();
    render(<ContactsPanel rendererRef={{ current: { focusEntity } }} />);
    fireEvent.click(screen.getByTestId(`contact-row-p:${PLAYER_ID}`));
    expect(focusEntity).toHaveBeenCalledWith(PLAYER_ID, 'ship');
  });

  it('the header prompt says a tap selects', () => {
    render(<ContactsPanel />);
    expect(screen.getByTestId('contacts-group')).toHaveTextContent('Tap a contact to select it');
  });

  it('locking-you rides the row data attrs (no Lock column)', () => {
    fakeMirror.localLockedBy = [{ t: 's:7', s: 2, p: 100 }, { t: 's:8', s: 1, p: 40 }];
    render(<ContactsPanel />);
    expect(screen.getByTestId('contact-row-s:7').getAttribute('data-locking-you')).toBe('2');
    expect(screen.getByTestId('contact-row-s:8').getAttribute('data-locking-you')).toBe('1');
  });

  it('the lock state refreshes from the mirror while open', () => {
    vi.useFakeTimers();
    try {
      render(<ContactsPanel />);
      expect(screen.getByTestId('contact-row-s:8').getAttribute('data-lock')).toBe('none');
      fakeMirror.localGroups[0]!.l = [{ t: 's:8', s: 1, p: 99.7 }];
      act(() => { vi.advanceTimersByTime(300); });
      const row = screen.getByTestId('contact-row-s:8');
      expect(row.getAttribute('data-lock')).toBe('acquiring');
    } finally {
      vi.useRealTimers();
    }
  });
});
