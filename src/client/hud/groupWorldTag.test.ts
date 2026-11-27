import { describe, expect, it } from 'vitest';
import { STANCE_COLOUR } from '../components/contactRows.js';
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

const ship = (name: string, hullPct: number | null = 100) => ({ name, hullPct });

describe('groupTagTitle', () => {
  it('counts ships, then each type in first-seen order, plural only above one', () => {
    const ships = [ship('Battleship'), ship('Fighter'), ship('Fighter'), ship('Battleship'), ship('Fighter')];
    expect(groupTagTitle(ships)).toBe('5 ships · 2 Battleships · 3 Fighters');
    expect(groupTagTitle([ship('Fighter'), ship('Corvette')])).toBe('2 ships · 1 Fighter · 1 Corvette');
  });

  it('a type ending in s takes "es"', () => {
    expect(groupTagTitle([ship('Atlas'), ship('Atlas')])).toBe('2 ships · 2 Atlases');
  });
});

describe('groupTagText', () => {
  it('line 2 "Yours" plus the shared order and stance, own colour; bar = average hull', () => {
    const t = groupTagText([ship('Fighter', 100), ship('Fighter', 50)], 'patrol', 'aggressive');
    expect(t).toEqual({
      title: '2 ships · 2 Fighters',
      owner: 'Yours · Patrol · Aggressive',
      ownerColor: STANCE_COLOUR.friendly,
      hullPct: 75,
    });
  });

  it('mixed or unknown order/stance is left out; unknown hulls skip the average', () => {
    const t = groupTagText([ship('Fighter', null), ship('Fighter', 40)], 'mixed', null);
    expect(t.owner).toBe('Yours');
    expect(t.hullPct).toBe(40);
    expect(groupTagText([ship('Fighter', null), ship('Fighter', null)], null, null).hullPct).toBeUndefined();
  });
});
