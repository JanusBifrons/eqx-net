import { describe, it, expect } from 'vitest';
import { decideTapAction, type TapAction, type TapContext } from './tapAction.js';

const base: TapContext = {
  pointerType: 'touch',
  hitOwn: false,
  hitEntity: false,
  hasSelection: false,
  additive: false,
};

type Row = [string, Partial<TapContext>, TapAction];

const rows: Row[] = [
  // own ship always selects
  ['touch on own ship, no selection', { hitOwn: true, hitEntity: true }, 'select'],
  ['touch on own ship, selection', { hitOwn: true, hitEntity: true, hasSelection: true }, 'select'],
  ['mouse on own ship', { pointerType: 'mouse', hitOwn: true, hitEntity: true, hasSelection: true }, 'select'],
  ['pen on own ship', { pointerType: 'pen', hitOwn: true, hitEntity: true, hasSelection: true }, 'select'],

  // a tap on something that is not mine, with ships selected: FOCUS it, the
  // ships stay selected (never an attack order: the Lock button orders that)
  ['touch enemy, selection', { hasSelection: true, hitEntity: true }, 'focus'],
  ['pen enemy, selection', { pointerType: 'pen', hasSelection: true, hitEntity: true }, 'focus'],
  ['mouse enemy, selection', { pointerType: 'mouse', hasSelection: true, hitEntity: true }, 'focus'],
  ['mouse shift-tap enemy, selection', { pointerType: 'mouse', hasSelection: true, hitEntity: true, additive: true }, 'focus'],

  // a tap on free space with a selection DESELECTS (never a move order)
  ['touch empty map, selection', { hasSelection: true }, 'deselect'],
  ['pen empty map, selection', { pointerType: 'pen', hasSelection: true }, 'deselect'],
  ['mouse empty map, selection', { pointerType: 'mouse', hasSelection: true }, 'deselect'],
  ['mouse shift-tap empty map, selection (keeps the ships)', { pointerType: 'mouse', hasSelection: true, additive: true }, 'inspect'],

  // nothing selected: inspect whatever is (or is not) under the tap
  ['touch empty map, no selection', {}, 'inspect'],
  ['touch enemy, no selection', { hitEntity: true }, 'inspect'],
  ['mouse empty map, no selection', { pointerType: 'mouse' }, 'inspect'],
];

describe('decideTapAction', () => {
  it.each(rows)('%s', (_name, over, want) => {
    expect(decideTapAction({ ...base, ...over })).toBe(want);
  });

  it('a touch tap never gives an order (move / attack stay on right-click)', () => {
    for (const hasSelection of [false, true]) {
      for (const hitEntity of [false, true]) {
        for (const pointerType of ['touch', 'pen']) {
          const a = decideTapAction({ ...base, pointerType, hasSelection, hitEntity });
          expect(a === 'select' || a === 'focus' || a === 'deselect' || a === 'inspect').toBe(true);
        }
      }
    }
  });
});
