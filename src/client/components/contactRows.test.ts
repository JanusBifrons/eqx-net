/**
 * Contacts overview row building (pure): what's lockable, names not ids,
 * distance, reach per group, lock state (acquiring capped at 99), locking-you,
 * type / faction / stance, the sort with a secondary key, filters, and the
 * tap action.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  DEFAULT_CONTACT_SORT, NO_CONTACT_FILTER, buildContactRows, contactFactions, contactStance,
  contactsSignature, filterContacts, formatContactKm, sortContacts, tapContactSort, type ContactSort,
} from './contactRows';

const PLAYER_ID = '0a1b2c3d-4e5f-4000-8000-000000000001';

function mirror(over: Partial<Record<string, unknown>> = {}): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map<string, unknown>([
      ['me', { x: 0, y: 0, kind: 'fighter' }],
      [PLAYER_ID, { x: 0, y: -3000, kind: 'fighter', displayName: 'Ripley' }],
    ]),
    swarm: new Map<number, unknown>([
      [7, { kind: 1, shipKind: 'fighter', x: 0, y: 1000, isHostileToLocal: true }],
      [8, { kind: 1, shipKind: 'heavy', x: 500, y: 0 }],
      [9, { kind: 0, x: 10, y: 10 }], // asteroid: not lockable
      [10, { kind: 2, shipKind: 'turret', x: 0, y: 20_000 }],
      [11, { kind: 2, shipKind: 'turret', x: 0, y: 50 }], // own structure: not lockable
      [12, { kind: 1, shipKind: 'fighter', x: 0, y: 60, warp: 2 }], // mid warp run: out of the world
    ]),
    structures: new Map<number, unknown>([
      [10, { owner: 'someone', ownerName: 'Vasquez' }],
      [11, { owner: 'me' }],
    ]),
    localGroups: [
      { id: 'guns', m: 1, l: [{ t: 's:7', s: 1, p: 99.6 }] },
      { id: 'missiles', m: 1, l: [{ t: 's:8', s: 2, p: 100 }] },
    ],
    localLockedBy: [{ t: 's:7', s: 1, p: 40 }],
    ...over,
  } as unknown as RenderMirror;
}

const REACHES = [{ id: 'guns', reach: 600 }, { id: 'missiles', reach: 2000 }];

describe('buildContactRows', () => {
  it('lists NPC ships, other pilots and foreign structures, by name, never by id', () => {
    const rows = buildContactRows(mirror(), 'guns', REACHES);
    expect(rows.map((r) => r.key).sort()).toEqual(['p:' + PLAYER_ID, 's:10', 's:7', 's:8'].sort());
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.name).toBe('Fighter');
    // A pilot's ship is named by its hull (the pilot is its Faction); a
    // structure by its kind (the owner is its Faction).
    expect(byKey.get('p:' + PLAYER_ID)!.name).toBe('Fighter');
    expect(byKey.get('s:10')!.name).toBe('Turret');
    for (const r of rows) {
      expect(r.name).not.toContain(PLAYER_ID);
      expect(r.name).not.toMatch(/\b(7|8|10)\b/);
    }
  });

  it('another player\'s AI-flown ship is a contact keyed by its shipInstanceId; your own fleet never is', () => {
    const THEIRS = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const MINE = 'bbbbbbbb-0000-4000-8000-0000000000bb';
    const rows = buildContactRows(mirror({
      ships: new Map<string, unknown>([
        ['me', { x: 0, y: 0, kind: 'fighter' }],
        [THEIRS, { x: 0, y: 400, kind: 'fighter', isActive: false, ownerPlayerId: PLAYER_ID, displayName: 'Ripley' }],
        [MINE, { x: 0, y: 300, kind: 'fighter', isActive: false, ownerPlayerId: 'me' }],
      ]),
    }), 'guns', REACHES);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('p:' + THEIRS);
    expect(keys).not.toContain('p:' + MINE);
    expect(keys).not.toContain('p:me');
    const row = rows.find((r) => r.key === 'p:' + THEIRS)!;
    expect(row.icon).toBe('ship');
    expect(row.inActiveReach).toBe(true);
  });

  it('icons follow the visual language: hostile / neutral NPC, ship, structure', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.icon).toBe('hostile');
    expect(byKey.get('s:8')!.icon).toBe('neutral');
    expect(byKey.get('p:' + PLAYER_ID)!.icon).toBe('ship');
    expect(byKey.get('s:10')!.icon).toBe('structure');
  });

  it('reach: the FIRE reach of the active group vs any group (not the lock range)', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    // 500 u: inside the guns (600).
    expect(byKey.get('s:8')).toMatchObject({ inActiveReach: true, inAnyReach: true });
    // 1000 u: only the missiles reach it.
    expect(byKey.get('s:7')).toMatchObject({ inActiveReach: false, inAnyReach: true });
    // 3000 u and 20 km: nothing.
    expect(byKey.get('p:' + PLAYER_ID)).toMatchObject({ inActiveReach: false, inAnyReach: false });
    // The mark is the guns' fire reach, not a lock limit: no lock slack.
    const edge = buildContactRows(mirror({ swarm: new Map([[8, { kind: 1, shipKind: 'heavy', x: 600 * 1.05, y: 0 }]]) }), 'guns', REACHES);
    expect(edge[0]!.inActiveReach).toBe(false);
    const inside = buildContactRows(mirror({ swarm: new Map([[8, { kind: 1, shipKind: 'heavy', x: 599, y: 0 }]]) }), 'guns', REACHES);
    expect(inside[0]!.inActiveReach).toBe(true);
  });

  it('lock state: acquiring capped at 99, locked 100, active group first; locking you', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.lock).toEqual({ groupId: 'guns', stage: 1, pct: 99 });
    expect(byKey.get('s:7')!.activeLock).not.toBeNull();
    expect(byKey.get('s:7')!.lockingYou).toBe(1);
    expect(byKey.get('s:8')!.lock).toEqual({ groupId: 'missiles', stage: 2, pct: 100 });
    expect(byKey.get('s:8')!.activeLock).toBeNull(); // another group's lock
    expect(byKey.get('s:10')!.lock).toBeNull();
  });

  it('a structure aiming at you, or anything locking you, counts as hostile', () => {
    const m = mirror({
      structures: new Map([[10, { owner: 'someone', turretTargetPlayerId: 'me' }]]),
      localLockedBy: [{ t: 'p:' + PLAYER_ID, s: 2, p: 100 }],
    });
    const byKey = new Map(buildContactRows(m, 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:10')!.hostile).toBe(true);
    expect(byKey.get('p:' + PLAYER_ID)).toMatchObject({ hostile: true, lockingYou: 2 });
    expect(byKey.get('s:8')!.hostile).toBe(false);
  });

  it('no local ship ⇒ no rows', () => {
    expect(buildContactRows(mirror({ localPlayerId: null }), 'guns', REACHES)).toEqual([]);
  });
});

describe('type, faction and stance', () => {
  it('type: ship or structure', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.type).toBe('ship');
    expect(byKey.get('p:' + PLAYER_ID)!.type).toBe('ship');
    expect(byKey.get('s:10')!.type).toBe('structure');
  });

  it('faction: a patrol\'s faction, else the kind\'s allegiance; a pilot is their own; a structure its owner; never an id', () => {
    const m = mirror({
      swarm: new Map<number, unknown>([
        [7, { kind: 1, shipKind: 'fighter', x: 0, y: 1000 }],
        [8, { kind: 1, shipKind: 'heavy', x: 500, y: 0, faction: 'core' }],
        [10, { kind: 2, shipKind: 'turret', x: 0, y: 20_000 }],
        [13, { kind: 2, shipKind: 'turret', x: 0, y: 900 }],
        [14, { kind: 2, shipKind: 'turret', x: 0, y: 800 }],
        [15, { kind: 2, shipKind: 'turret', x: 0, y: 700 }],
      ]),
      structures: new Map<number, unknown>([
        [10, { owner: 'someone', ownerName: 'Vasquez' }],
        [13, { owner: 'npc:traders:hub-1' }],
        [14, { owner: 'orphan' }],
        // 15: no structure slice yet
      ]),
      ships: new Map<string, unknown>([
        ['me', { x: 0, y: 0, kind: 'fighter' }],
        [PLAYER_ID, { x: 0, y: -3000, kind: 'fighter', displayName: 'Ripley' }],
        ['anon', { x: 0, y: -100, kind: 'fighter', displayName: '' }],
      ]),
    });
    const byKey = new Map(buildContactRows(m, 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.faction).toBe('Drones');
    expect(byKey.get('s:8')!.faction).toBe('Sol Dominion');
    expect(byKey.get('p:' + PLAYER_ID)!.faction).toBe('Ripley');
    expect(byKey.get('p:anon')!.faction).toBe('Unknown');
    expect(byKey.get('s:10')!.faction).toBe('Vasquez');
    expect(byKey.get('s:13')!.faction).toBe('Traders');
    expect(byKey.get('s:14')!.faction).toBe('Unknown');
    expect(byKey.get('s:15')!.faction).toBe('Unknown');
    for (const r of byKey.values()) expect(r.faction).not.toContain(PLAYER_ID);
  });

  it('stance: hostile wins; other pilots and their structures are friendly; the rest neutral', () => {
    expect(contactStance(true, true, 'fighter')).toBe('hostile');
    expect(contactStance(false, true, 'fighter')).toBe('friendly');
    expect(contactStance(true, false, 'trader-hauler')).toBe('hostile');
    expect(contactStance(false, false, 'trader-hauler')).toBe('neutral');
    expect(contactStance(false, false, undefined)).toBe('neutral');
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.stance).toBe('hostile');
    expect(byKey.get('s:8')!.stance).toBe('neutral');
    expect(byKey.get('p:' + PLAYER_ID)!.stance).toBe('friendly');
    expect(byKey.get('s:10')!.stance).toBe('friendly'); // another player's turret, not aiming at you
    const locking = buildContactRows(mirror({ localLockedBy: [{ t: 'p:' + PLAYER_ID, s: 1, p: 10 }] }), 'guns', REACHES);
    expect(locking.find((r) => r.key === 'p:' + PLAYER_ID)!.stance).toBe('hostile');
    const npcBase = buildContactRows(mirror({ structures: new Map([[10, { owner: 'npc:traders:hub-1' }]]) }), 'guns', REACHES);
    expect(npcBase.find((r) => r.key === 's:10')!.stance).toBe('neutral');
  });
});

const keysOf = (rows: ReadonlyArray<{ key: string }>): string[] => rows.map((r) => r.key);

describe('sortContacts', () => {
  it('default: distance ascending; desc reverses it', () => {
    const rows = buildContactRows(mirror(), 'guns', REACHES);
    expect(keysOf(sortContacts([...rows], DEFAULT_CONTACT_SORT))).toEqual(['s:8', 's:7', 'p:' + PLAYER_ID, 's:10']);
    expect(keysOf(sortContacts([...rows], [{ key: 'dist', dir: 'desc' }]))).toEqual(['s:10', 'p:' + PLAYER_ID, 's:7', 's:8']);
  });

  it('stance asc puts hostiles first; the secondary key orders within each stance', () => {
    const rows = buildContactRows(mirror(), 'guns', REACHES);
    const byStance: ContactSort = [{ key: 'stance', dir: 'asc' }, { key: 'dist', dir: 'asc' }];
    expect(keysOf(sortContacts([...rows], byStance))).toEqual(['s:7', 's:8', 'p:' + PLAYER_ID, 's:10']);
    const byTypeThenFar: ContactSort = [{ key: 'type', dir: 'asc' }, { key: 'dist', dir: 'desc' }];
    expect(keysOf(sortContacts([...rows], byTypeThenFar))).toEqual(['p:' + PLAYER_ID, 's:7', 's:8', 's:10']);
  });

  it('ties fall back to distance, then the key, so the order never jitters between polls', () => {
    const swarm = new Map<number, unknown>([
      [21, { kind: 1, shipKind: 'fighter', x: 0, y: 300 }],
      [20, { kind: 1, shipKind: 'fighter', x: 0, y: 300 }],
      [22, { kind: 1, shipKind: 'fighter', x: 0, y: 100 }],
    ]);
    const rows = buildContactRows(mirror({ swarm, ships: new Map([['me', { x: 0, y: 0 }]]) }), 'guns', REACHES);
    expect(keysOf(sortContacts([...rows], [{ key: 'name', dir: 'asc' }]))).toEqual(['s:22', 's:20', 's:21']);
    expect(keysOf(sortContacts([...rows].reverse(), [{ key: 'name', dir: 'asc' }]))).toEqual(['s:22', 's:20', 's:21']);
  });

  it('lock asc: locked, then acquiring, then locking you, then the rest', () => {
    const byLock: ContactSort = [{ key: 'lock', dir: 'asc' }];
    expect(keysOf(sortContacts(buildContactRows(mirror(), 'guns', REACHES), byLock))).toEqual(['s:8', 's:7', 'p:' + PLAYER_ID, 's:10']);
    const m = mirror({ localGroups: [{ id: 'guns', m: 1, l: [{ t: 's:8', s: 2, p: 100 }] }], localLockedBy: [{ t: 's:10', s: 2, p: 100 }] });
    expect(keysOf(sortContacts(buildContactRows(m, 'guns', REACHES), byLock))).toEqual(['s:8', 's:10', 's:7', 'p:' + PLAYER_ID]);
    expect(keysOf(sortContacts(buildContactRows(m, 'guns', REACHES), [{ key: 'lock', dir: 'desc' }]))).toEqual(['s:7', 'p:' + PLAYER_ID, 's:10', 's:8']);
  });

  it('no cap: every contact is kept (the panel pages them)', () => {
    const swarm = new Map<number, unknown>();
    for (let i = 0; i < 60; i++) swarm.set(100 + i, { kind: 1, shipKind: 'fighter', x: i * 10, y: 0 });
    expect(sortContacts(buildContactRows(mirror({ swarm }), 'guns', REACHES), DEFAULT_CONTACT_SORT)).toHaveLength(61);
  });
});

describe('tapContactSort', () => {
  it('the primary flips; another column becomes primary (asc) and the old primary secondary', () => {
    expect(tapContactSort(DEFAULT_CONTACT_SORT, 'dist')).toEqual([{ key: 'dist', dir: 'desc' }]);
    const s1 = tapContactSort(DEFAULT_CONTACT_SORT, 'stance');
    expect(s1).toEqual([{ key: 'stance', dir: 'asc' }, { key: 'dist', dir: 'asc' }]);
    expect(tapContactSort(s1, 'stance')).toEqual([{ key: 'stance', dir: 'desc' }, { key: 'dist', dir: 'asc' }]);
    expect(tapContactSort(s1, 'faction')).toEqual([{ key: 'faction', dir: 'asc' }, { key: 'stance', dir: 'asc' }]);
    // Tapping the secondary promotes it (fresh asc); the old primary drops to secondary.
    expect(tapContactSort(s1, 'dist')).toEqual([{ key: 'dist', dir: 'asc' }, { key: 'stance', dir: 'asc' }]);
  });
});

describe('filterContacts + contactFactions', () => {
  it('filters by type, faction and stance together; no filter keeps every row', () => {
    const rows = buildContactRows(mirror(), 'guns', REACHES);
    expect(filterContacts(rows, NO_CONTACT_FILTER)).toHaveLength(4);
    expect(keysOf(filterContacts(rows, { ...NO_CONTACT_FILTER, type: 'structure' }))).toEqual(['s:10']);
    expect(keysOf(filterContacts(rows, { ...NO_CONTACT_FILTER, stance: 'hostile' }))).toEqual(['s:7']);
    expect(keysOf(filterContacts(rows, { ...NO_CONTACT_FILTER, faction: 'Drones' })).sort()).toEqual(['s:7', 's:8']);
    expect(filterContacts(rows, { type: 'ship', faction: 'Drones', stance: 'friendly' })).toEqual([]);
  });

  it('the faction options are the distinct factions present, sorted', () => {
    expect(contactFactions(buildContactRows(mirror(), 'guns', REACHES))).toEqual(['Drones', 'Ripley', 'Vasquez']);
  });
});

describe('formatContactKm', () => {
  it('metres under 1 km, one decimal under 10 km, whole km beyond', () => {
    expect(formatContactKm(0)).toBe('0 m');
    expect(formatContactKm(447)).toBe('450 m');
    expect(formatContactKm(1000)).toBe('1.0 km');
    expect(formatContactKm(3240)).toBe('3.2 km');
    expect(formatContactKm(38_700)).toBe('39 km');
    expect(formatContactKm(Number.NaN)).toBe('—');
  });
});

describe('contactsSignature', () => {
  it('the signature ignores sub-display distance changes and sees lock changes', () => {
    const a = buildContactRows(mirror(), 'guns', REACHES);
    const b = buildContactRows(mirror({ ships: new Map<string, unknown>([['me', { x: 1, y: 0 }], [PLAYER_ID, { x: 0, y: -3000, kind: 'fighter', displayName: 'Ripley' }]]) }), 'guns', REACHES);
    expect(contactsSignature(a)).toBe(contactsSignature(b));
    const c = buildContactRows(mirror({ localGroups: [{ id: 'guns', m: 1, l: [{ t: 's:7', s: 2, p: 100 }] }] }), 'guns', REACHES);
    expect(contactsSignature(c)).not.toBe(contactsSignature(a));
    // A faction change shows too.
    const d = buildContactRows(mirror({ structures: new Map([[10, { owner: 'someone', ownerName: 'Hicks' }]]) }), 'guns', REACHES);
    expect(contactsSignature(d)).not.toBe(contactsSignature(a));
  });
});
