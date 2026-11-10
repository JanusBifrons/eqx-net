/**
 * Contacts overview row building (pure): what's lockable, names not ids,
 * distance, reach per group, lock state (acquiring capped at 99), locking-you,
 * sort with hostiles first, and the tap action.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { LOCK_TUNING } from '@shared-types/combat/lockProfile';
import {
  CONTACTS_MAX_ROWS, buildContactRows, contactTapAction, contactsSignature, formatContactKm, sortContacts,
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
    expect(byKey.get('p:' + PLAYER_ID)!.name).toBe('Ripley');
    expect(byKey.get('s:10')!.name).toBe('Turret · Vasquez');
    for (const r of rows) {
      expect(r.name).not.toContain(PLAYER_ID);
      expect(r.name).not.toMatch(/\b(7|8|10)\b/);
    }
  });

  it('icons follow the visual language: hostile / neutral NPC, ship, structure', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(byKey.get('s:7')!.icon).toBe('hostile');
    expect(byKey.get('s:8')!.icon).toBe('neutral');
    expect(byKey.get('p:' + PLAYER_ID)!.icon).toBe('ship');
    expect(byKey.get('s:10')!.icon).toBe('structure');
  });

  it('reach: active group vs any group, with the shared reachSlack', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    // 500 u: inside the guns (600 × slack).
    expect(byKey.get('s:8')).toMatchObject({ inActiveReach: true, inAnyReach: true });
    // 1000 u: only the missiles reach it.
    expect(byKey.get('s:7')).toMatchObject({ inActiveReach: false, inAnyReach: true });
    // 3000 u and 20 km: nothing.
    expect(byKey.get('p:' + PLAYER_ID)).toMatchObject({ inActiveReach: false, inAnyReach: false });
    // Just past 600 u but inside 600 × slack still counts.
    const edge = buildContactRows(mirror({ swarm: new Map([[8, { kind: 1, shipKind: 'heavy', x: 600 * LOCK_TUNING.reachSlack - 1, y: 0 }]]) }), 'guns', REACHES);
    expect(edge[0]!.inActiveReach).toBe(true);
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

describe('sortContacts', () => {
  it('nearest first, or hostiles first then nearest', () => {
    const rows = buildContactRows(mirror(), 'guns', REACHES);
    expect(sortContacts([...rows], false).map((r) => r.key)).toEqual(['s:8', 's:7', 'p:' + PLAYER_ID, 's:10']);
    expect(sortContacts([...rows], true).map((r) => r.key)).toEqual(['s:7', 's:8', 'p:' + PLAYER_ID, 's:10']);
  });

  it(`caps the list at ${CONTACTS_MAX_ROWS}`, () => {
    const swarm = new Map<number, unknown>();
    for (let i = 0; i < CONTACTS_MAX_ROWS + 10; i++) swarm.set(100 + i, { kind: 1, shipKind: 'fighter', x: i * 10, y: 0 });
    const rows = sortContacts(buildContactRows(mirror({ swarm }), 'guns', REACHES), false);
    expect(rows).toHaveLength(CONTACTS_MAX_ROWS);
    expect(rows[0]!.dist).toBe(0);
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

describe('contactTapAction + signature', () => {
  it('cancels only the active group’s own lock, else locks', () => {
    const byKey = new Map(buildContactRows(mirror(), 'guns', REACHES).map((r) => [r.key, r]));
    expect(contactTapAction(byKey.get('s:7')!)).toBe('cancel'); // guns acquiring
    expect(contactTapAction(byKey.get('s:8')!)).toBe('lock'); // locked by missiles, not guns
    expect(contactTapAction(byKey.get('s:10')!)).toBe('lock');
  });

  it('the signature ignores sub-display distance changes and sees lock changes', () => {
    const a = buildContactRows(mirror(), 'guns', REACHES);
    const b = buildContactRows(mirror({ ships: new Map<string, unknown>([['me', { x: 1, y: 0 }], [PLAYER_ID, { x: 0, y: -3000, displayName: 'Ripley' }]]) }), 'guns', REACHES);
    expect(contactsSignature(sortContacts(a, true))).toBe(contactsSignature(sortContacts(b, true)));
    const c = buildContactRows(mirror({ localGroups: [{ id: 'guns', m: 1, l: [{ t: 's:7', s: 2, p: 100 }] }] }), 'guns', REACHES);
    expect(contactsSignature(sortContacts(c, true))).not.toBe(contactsSignature(sortContacts(a, true)));
  });
});
