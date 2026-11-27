/**
 * Selection-HUD S2b: the do-hexes' honeycomb. Main action under the thumb
 * (bottom-right), cancel in the far corner, the rest by nearness; two rows of
 * three, the upper row half a pitch left.
 */
import { describe, expect, it } from 'vitest';
import { HUD } from '../hud/tokens';
import { DO_HEX_PITCH, DO_HEX_ROW_PITCH, doHexCellOrder, doHexLayout, type DoHex } from './doHexLayout';

const hex = (key: string, role?: DoHex['role']): DoHex => ({
  key, testId: key, icon: null, word: key, tooltip: key, tone: 'neutral', onPress: () => {},
  ...(role !== undefined ? { role } : {}),
});

describe('doHexLayout', () => {
  it('main takes the thumb cell, cancel the farthest, the rest fill by nearness', () => {
    expect(doHexCellOrder([hex('a'), hex('main', 'main'), hex('b')])).toEqual([1, 0, 2]);
    expect(doHexCellOrder([hex('x', 'cancel'), hex('a'), hex('b'), hex('c')])).toEqual([3, 0, 1, 2]);
    expect(doHexCellOrder([hex('m', 'main'), hex('a'), hex('b'), hex('c'), hex('d'), hex('x', 'cancel')]))
      .toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a lone cancel still sits under the thumb', () => {
    expect(doHexCellOrder([hex('x', 'cancel')])).toEqual([0]);
  });

  it('drops anything past six', () => {
    const many = Array.from({ length: 8 }, (_, i) => hex(`h${i}`));
    expect(doHexLayout(many).cells).toHaveLength(6);
  });

  it('six hexes: bottom row flush right, top row half a pitch left, box fits both', () => {
    const l = doHexLayout(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => hex(k)));
    const at = (k: string) => l.cells.find((c) => c.hex.key === k)!;
    expect([at('a').right, at('a').bottom]).toEqual([0, 0]);
    expect([at('b').right, at('b').bottom]).toEqual([DO_HEX_PITCH, 0]);
    expect([at('c').right, at('c').bottom]).toEqual([DO_HEX_PITCH / 2, DO_HEX_ROW_PITCH]);
    expect([at('d').right, at('d').bottom]).toEqual([2 * DO_HEX_PITCH, 0]);
    expect([at('f').right, at('f').bottom]).toEqual([2.5 * DO_HEX_PITCH, DO_HEX_ROW_PITCH]);
    expect(l.width).toBe(2.5 * DO_HEX_PITCH + HUD.hex.w);
    expect(l.height).toBe(DO_HEX_ROW_PITCH + HUD.hex.h);
  });

  it('neighbouring hexes never touch: the gap is kept along and across rows', () => {
    // Pointy-top hexes of width w touch at pitch w (along a row) and w*sqrt(3)/2 (across).
    expect(DO_HEX_PITCH).toBeGreaterThan(HUD.hex.w);
    expect(DO_HEX_ROW_PITCH).toBeGreaterThan(HUD.hex.w * Math.sqrt(3) / 2);
  });

  it('a short set stays one row', () => {
    const l = doHexLayout([hex('a', 'main'), hex('b')]);
    expect(l.cells.every((c) => c.row === 0)).toBe(true);
    expect(l.height).toBe(HUD.hex.h);
  });
});
