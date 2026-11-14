import { describe, it, expect } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  applySelection,
  boxSelectOwn,
  collectFleetShips,
  isOwnShipPresent,
  pickOwnShipAt,
  sameSelection,
  type FleetShip,
} from './fleetSelection.js';

const ME = 'me';
const ship = (id: string, x: number, y: number, owner = ME): FleetShip => ({ id, x, y, ownerPlayerId: owner, radius: 20 });

function mirror(): RenderMirror {
  return {
    localPlayerId: ME,
    ships: new Map([
      [ME, { x: 0, y: 0, angle: 0 }],
      ['other', { x: 50, y: 50, angle: 0 }],
    ]),
    lingeringShips: new Map([
      ['hull-1', { x: 100, y: 0, angle: 0, ownerPlayerId: ME }],
      ['hull-2', { x: 200, y: 0, angle: 0, ownerPlayerId: 'other' }],
    ]),
  } as unknown as RenderMirror;
}

describe('boxSelectOwn', () => {
  const ships = [ship('a', 10, 10), ship('b', 90, 90), ship('c', -50, 10), ship('enemy', 20, 20, 'them')];

  it('returns own ships whose centre is inside the box', () => {
    expect(boxSelectOwn(0, 0, 100, 100, ships, ME).sort()).toEqual(['a', 'b']);
  });

  it('accepts corners in any order', () => {
    expect(boxSelectOwn(100, 100, 0, 0, ships, ME).sort()).toEqual(['a', 'b']);
    expect(boxSelectOwn(-60, 20, 15, 0, ships, ME).sort()).toEqual(['a', 'c']);
  });

  it('excludes ships owned by anyone else', () => {
    expect(boxSelectOwn(15, 15, 25, 25, ships, ME)).toEqual([]);
  });

  it('selects nothing without a local player', () => {
    expect(boxSelectOwn(0, 0, 100, 100, ships, null)).toEqual([]);
  });
});

describe('collectFleetShips + mirror helpers', () => {
  it('owns the active ship by playerId and lingering hulls by ownerPlayerId', () => {
    const m = mirror();
    const ids = boxSelectOwn(-1000, -1000, 1000, 1000, collectFleetShips(m), ME).sort();
    expect(ids).toEqual(['hull-1', ME]);
  });

  it('pickOwnShipAt hits the nearest own ship within radius + slop, never a foreign one', () => {
    const m = mirror();
    const ships = collectFleetShips(m);
    expect(pickOwnShipAt(95, 5, ships, ME)).toBe('hull-1');
    expect(pickOwnShipAt(200, 0, ships, ME)).toBeNull(); // hull-2 belongs to 'other'
    expect(pickOwnShipAt(50, 50, ships, ME)).toBeNull(); // 'other' active ship
  });

  it('isOwnShipPresent tracks own ships only', () => {
    const m = mirror();
    expect(isOwnShipPresent(ME, m)).toBe(true);
    expect(isOwnShipPresent('hull-1', m)).toBe(true);
    expect(isOwnShipPresent('hull-2', m)).toBe(false);
    expect(isOwnShipPresent('gone', m)).toBe(false);
  });
});

describe('applySelection', () => {
  it('non-additive replaces (empty hits clear)', () => {
    const cur = new Set(['a', 'b']);
    expect([...applySelection(cur, ['c'], false)]).toEqual(['c']);
    expect(applySelection(cur, [], false).size).toBe(0);
  });

  it('additive adds unselected hits', () => {
    expect([...applySelection(new Set(['a']), ['b', 'c'], true)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('additive single hit already selected toggles it off', () => {
    expect([...applySelection(new Set(['a', 'b']), ['a'], true)]).toEqual(['b']);
  });

  it('additive box including selected ships only adds', () => {
    expect([...applySelection(new Set(['a']), ['a', 'b'], true)].sort()).toEqual(['a', 'b']);
  });

  it('never mutates the current set', () => {
    const cur = new Set(['a']);
    applySelection(cur, ['b'], true);
    applySelection(cur, ['a'], true);
    expect([...cur]).toEqual(['a']);
  });

  it('sameSelection compares contents', () => {
    expect(sameSelection(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSelection(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });
});
