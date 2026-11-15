/**
 * Squad selection rules (RTS slice 15a): a tap selects the whole squad, a tap
 * on an exactly-selected squad narrows to that ship, a box selects whole
 * squads it touches, shift-add adds the whole squad.
 */
import { describe, it, expect } from 'vitest';
import { boxSelectOwn, expandToSquads, tapSelectOwn, type FleetShip, type SquadOf } from './fleetSelection.js';

const ME = 'me';
const ship = (id: string, x: number, y: number, owner = ME): FleetShip => ({ id, x, y, ownerPlayerId: owner, radius: 20 });

// Squad A = me + a1 + a2; squad B = b1 + b2; solo = s; foreign x is in squad A's id (must never join).
const SHIPS: FleetShip[] = [
  ship(ME, 0, 0),
  ship('a1', 100, 0),
  ship('a2', 200, 0),
  ship('b1', 0, 500),
  ship('b2', 100, 500),
  ship('s', 1000, 1000),
  ship('x', 150, 0, 'other'),
];
const SQUADS: Record<string, string> = { [ME]: 'A', a1: 'A', a2: 'A', b1: 'B', b2: 'B', x: 'A' };
const squadOf: SquadOf = (id) => SQUADS[id];
const set = (...ids: string[]): Set<string> => new Set(ids);
const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('expandToSquads', () => {
  it('returns the hits untouched without a squad lookup', () => {
    const hits = ['a1'];
    expect(expandToSquads(hits, SHIPS, ME)).toBe(hits);
  });
  it('returns the hits untouched when no hit is in a squad', () => {
    const hits = ['s'];
    expect(expandToSquads(hits, SHIPS, ME, squadOf)).toBe(hits);
  });
  it('adds own squad mates only (never another owner\'s ship), hits first, no duplicates', () => {
    expect(expandToSquads(['a1', ME], SHIPS, ME, squadOf)).toEqual(['a1', ME, 'a2']);
  });
  it('expands several squads at once', () => {
    expect(sorted(expandToSquads(['a2', 'b2'], SHIPS, ME, squadOf))).toEqual(sorted([ME, 'a1', 'a2', 'b1', 'b2']));
  });
  it('is empty with no local player', () => {
    expect(expandToSquads(['a1'], SHIPS, null, squadOf)).toEqual(['a1']);
  });
});

describe('tapSelectOwn', () => {
  type Row = { name: string; current: string[]; hit: string; additive: boolean; expected: string[] };
  const rows: Row[] = [
    { name: 'tap a squad member selects the whole squad', current: [], hit: 'a1', additive: false, expected: [ME, 'a1', 'a2'] },
    { name: 'tap replaces another selection with the squad', current: ['b1', 'b2'], hit: 'a2', additive: false, expected: [ME, 'a1', 'a2'] },
    { name: 'tap the same ship of an exactly-selected squad narrows to it', current: [ME, 'a1', 'a2'], hit: 'a1', additive: false, expected: ['a1'] },
    { name: 'tap another member of an exactly-selected squad narrows to that one', current: [ME, 'a1', 'a2'], hit: 'a2', additive: false, expected: ['a2'] },
    { name: 'tap again after narrowing re-selects the whole squad', current: ['a1'], hit: 'a1', additive: false, expected: [ME, 'a1', 'a2'] },
    { name: 'squad plus extra ship selected: tap re-selects the squad only', current: [ME, 'a1', 'a2', 's'], hit: 'a1', additive: false, expected: [ME, 'a1', 'a2'] },
    { name: 'tap a solo ship selects just it', current: [], hit: 's', additive: false, expected: ['s'] },
    { name: 'tap a selected solo ship keeps it selected', current: ['s'], hit: 's', additive: false, expected: ['s'] },
    { name: 'shift-add a squad member adds the whole squad', current: ['s'], hit: 'b1', additive: true, expected: ['s', 'b1', 'b2'] },
    { name: 'shift-add completes a partly selected squad', current: ['a1'], hit: 'a2', additive: true, expected: [ME, 'a1', 'a2'] },
    { name: 'shift on a selected ship removes just that ship', current: [ME, 'a1', 'a2'], hit: 'a1', additive: true, expected: [ME, 'a2'] },
    { name: 'shift-add a solo ship adds it', current: ['b1', 'b2'], hit: 's', additive: true, expected: ['b1', 'b2', 's'] },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const cur = set(...r.current);
      const next = tapSelectOwn(cur, r.hit, r.additive, SHIPS, ME, squadOf);
      expect(sorted(next)).toEqual(sorted(r.expected));
      expect(next).not.toBe(cur);
      expect(sorted(cur)).toEqual(sorted(r.current)); // never mutated
    });
  }
  it('without squads behaves as the 13a single-ship select', () => {
    expect(sorted(tapSelectOwn(set(), 'a1', false, SHIPS, ME))).toEqual(['a1']);
    expect(sorted(tapSelectOwn(set('a1'), 'a1', true, SHIPS, ME))).toEqual([]);
  });
});

describe('boxSelectOwn with squads', () => {
  it('a box touching one squad member selects the whole squad', () => {
    expect(sorted(boxSelectOwn(90, -10, 110, 10, SHIPS, ME, squadOf))).toEqual(sorted([ME, 'a1', 'a2']));
  });
  it('a box over ships of two squads selects both squads', () => {
    expect(sorted(boxSelectOwn(-10, -10, 10, 510, SHIPS, ME, squadOf))).toEqual(sorted([ME, 'a1', 'a2', 'b1', 'b2']));
  });
  it('a box over a solo ship selects just it', () => {
    expect(boxSelectOwn(990, 990, 1010, 1010, SHIPS, ME, squadOf)).toEqual(['s']);
  });
  it('without squads only the ships inside the box', () => {
    expect(boxSelectOwn(90, -10, 110, 10, SHIPS, ME)).toEqual(['a1']);
  });
});
