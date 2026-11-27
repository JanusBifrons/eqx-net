import { describe, expect, it } from 'vitest';
import { STANCE_COLOUR } from '../components/contactRows.js';
import { groupSelectionByKind } from '../fleet/fleetView.js';
import { groupTagText, groupTagTitle, worldTagMode } from './groupWorldTag.js';

describe('worldTagMode', () => {
  it('2+ own ships with the focus among them, or none: one group tag', () => {
    expect(worldTagMode(['a', 'b'], null)).toBe('group');
    expect(worldTagMode(['a', 'b'], 'b')).toBe('group');
  });

  it('own ships selected and a focus outside them: the target tag', () => {
    expect(worldTagMode(['a', 'b'], 'enemy')).toBe('target');
    expect(worldTagMode(['a'], 'enemy')).toBe('target');
  });

  it('one ship or no selection: the focus tag, or nothing', () => {
    expect(worldTagMode(['a'], 'a')).toBe('single');
    expect(worldTagMode([], 'x')).toBe('single');
    expect(worldTagMode([], null)).toBe('none');
    expect(worldTagMode(['a'], null)).toBe('none');
  });
});

const ship = (hullPct: number | null = 100) => ({ hullPct });
/** The who-hexes' grouping over a selection of these kinds (ids s0, s1, ...). */
const kindGroups = (kinds: readonly (string | undefined)[]) =>
  groupSelectionByKind(
    kinds.map((_, i) => `s${i}`),
    (id) => kinds[Number(id.slice(1))],
  );
const fighters2 = kindGroups(['fighter', 'fighter']);

describe('groupTagTitle', () => {
  it('counts ships, then each type, plural only above one', () => {
    const groups = kindGroups(['battleship', 'fighter', 'fighter', 'battleship', 'fighter']);
    expect(groupTagTitle(groups)).toBe('5 ships · 2 Battleships · 3 Fighters');
    expect(groupTagTitle(kindGroups(['fighter']))).toBe('1 ship · 1 Fighter');
  });

  it('agrees with groupSelectionByKind (the who-hexes) on a mixed selection: kinds, counts, order', () => {
    const groups = kindGroups(['fighter', 'battleship', undefined, 'fighter', 'battleship', 'fighter']);
    expect(groups.map((g) => [g.displayName, g.count])).toEqual([
      ['Battleship', 2],
      ['Fighter', 3],
      ['Ship', 1],
    ]);
    expect(groupTagTitle(groups)).toBe('6 ships · 2 Battleships · 3 Fighters · 1 Ship');
  });

  it('a type ending in s takes "es"', () => {
    expect(groupTagTitle([{ displayName: 'Atlas', count: 2 }])).toBe('2 ships · 2 Atlases');
  });
});

describe('groupTagText', () => {
  it('line 2 "Yours" plus the shared order and stance, own colour; bar = average hull', () => {
    const t = groupTagText([ship(100), ship(50)], fighters2, 'patrol', 'aggressive');
    expect(t).toEqual({
      title: '2 ships · 2 Fighters',
      compactTitle: '2 ships',
      owner: 'Yours · Patrol · Aggressive',
      ownerColor: STANCE_COLOUR.friendly,
      hullPct: 75,
    });
  });

  it('mixed or unknown order/stance is left out; unknown hulls skip the average', () => {
    const t = groupTagText([ship(null), ship(40)], fighters2, 'mixed', null);
    expect(t.owner).toBe('Yours');
    expect(t.hullPct).toBe(40);
    expect(groupTagText([ship(null), ship(null)], fighters2, null, null).hullPct).toBeUndefined();
  });
});
