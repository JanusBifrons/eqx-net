import { describe, it, expect } from 'vitest';
import { decideTapAction, type TapAction, type TapContext } from './tapAction.js';

const base: TapContext = {
  pointerType: 'touch',
  hitOwn: false,
  hitEntity: false,
  hitAttackable: false,
  hasSelection: false,
  orderMode: 'move',
  additive: false,
};

type Row = [string, Partial<TapContext>, TapAction];

const rows: Row[] = [
  // own ship always selects
  ['touch on own ship, no selection', { hitOwn: true }, 'select'],
  ['touch on own ship, selection, move mode', { hitOwn: true, hasSelection: true }, 'select'],
  ['touch on own ship, selection, attack mode', { hitOwn: true, hasSelection: true, orderMode: 'attack' }, 'select'],
  ['mouse on own ship', { pointerType: 'mouse', hitOwn: true, hasSelection: true }, 'select'],
  ['pen on own ship', { pointerType: 'pen', hitOwn: true, hasSelection: true }, 'select'],

  // touch/pen + selection = order
  ['touch empty map, selection, move', { hasSelection: true }, 'orderMove'],
  ['touch enemy, selection, move (moves to the point)', { hasSelection: true, hitEntity: true, hitAttackable: true }, 'orderMove'],
  ['touch asteroid, selection, move', { hasSelection: true, hitEntity: true }, 'orderMove'],
  ['touch enemy, selection, attack', { hasSelection: true, orderMode: 'attack', hitEntity: true, hitAttackable: true }, 'orderAttack'],
  ['touch asteroid, selection, attack', { hasSelection: true, orderMode: 'attack', hitEntity: true }, 'none'],
  ['touch empty map, selection, attack', { hasSelection: true, orderMode: 'attack' }, 'none'],
  ['pen empty map, selection, move', { pointerType: 'pen', hasSelection: true }, 'orderMove'],
  ['pen enemy, selection, attack', { pointerType: 'pen', hasSelection: true, orderMode: 'attack', hitEntity: true, hitAttackable: true }, 'orderAttack'],

  // touch with no selection = inspect
  ['touch empty map, no selection', {}, 'inspect'],
  ['touch enemy, no selection, attack mode', { orderMode: 'attack', hitEntity: true, hitAttackable: true }, 'inspect'],

  // mouse unchanged: left tap inspects, clearing a selection
  ['mouse empty map, no selection', { pointerType: 'mouse' }, 'inspect'],
  ['mouse empty map, selection', { pointerType: 'mouse', hasSelection: true }, 'deselect'],
  ['mouse enemy, selection, attack mode', { pointerType: 'mouse', hasSelection: true, orderMode: 'attack', hitEntity: true, hitAttackable: true }, 'deselect'],
  ['mouse shift-tap empty map, selection', { pointerType: 'mouse', hasSelection: true, additive: true }, 'inspect'],
];

describe('decideTapAction', () => {
  it.each(rows)('%s', (_name, over, want) => {
    expect(decideTapAction({ ...base, ...over })).toBe(want);
  });
});
