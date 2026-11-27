/**
 * The do-hexes' honeycomb (selection-HUD redesign S2b, owner sign-off
 * 2026-11-27): up to 6 pointy-top hex buttons in the `bottom-right` slot, each
 * an icon plus a word. Pure layout, unit-tested; `DoHexesHost` draws it.
 *
 * Two rows of three. The bottom row sits flush with the slot's bottom-right
 * corner; the row above is shifted half a pitch left (a honeycomb). Cells are
 * placed by thumb nearness, so the order the actions are given in is the order
 * they get the nearest free cell:
 *
 * ```
 *      [5] [4] [2]          row 1 (shifted half a pitch left)
 *    [3] [1] [0]            row 0 (flush bottom-right; [0] under the thumb)
 * ```
 *
 * - `role: 'main'` always takes cell 0 (thumb-nearest, bottom-right).
 * - `role: 'cancel'` takes the farthest cell in use (cell n-1; with 6 hexes
 *   the top-left corner).
 * - Everything else fills the remaining cells in the order given.
 * - More than 6 hexes: the extra ones are dropped (the builders never send more).
 */
import type { ReactNode } from 'react';
import type { EqxTone } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';

/** One do-hex: an action with an icon and a short word. */
export interface DoHex {
  key: string;
  testId: string;
  icon: ReactNode;
  /** The short word under the icon ("Move"). */
  word: string;
  /** Tooltip and aria-label (longer than the word). */
  tooltip: string;
  /** Colour hint on the edge + icon (green move, red attack, blue patrol, cyan More, grey the rest). */
  tone: EqxTone;
  /** The current / armed action: stronger edge and glow. */
  lit?: boolean;
  /** Faded but still tappable (nothing to act on yet: no lock target, nothing in reach). */
  dim?: boolean;
  /** Faded and blocked (Place on a rejected ghost, Upgrade at the top level). */
  disabled?: boolean;
  /** `main` = thumb-nearest cell; `cancel` = the far corner. */
  role?: 'main' | 'cancel';
  onPress: () => void;
  /** A HOLD control (Boost): the host wraps the hex in `HoldButton` and calls
   *  this on press and release (and on unmount while held); `onPress` is unused. */
  onHold?: (down: boolean) => void;
  /** `data-state`, for tests. */
  state?: string;
}

/** The most hexes the honeycomb holds. */
export const DO_HEX_MAX = 6;

/** Gap between two neighbouring hexes' flat sides (px). */
export const DO_HEX_GAP = 4;

/** Centre-to-centre distance along a row (px). */
export const DO_HEX_PITCH = HUD.hex.w + DO_HEX_GAP;

/** Row-to-row distance (px): a honeycomb's rows are pitch x sqrt(3)/2 apart. */
export const DO_HEX_ROW_PITCH = Math.round(DO_HEX_PITCH * Math.sqrt(3) / 2 * 10) / 10;

/** Cells in thumb-nearness order: [row, column], column counted from the right. */
const CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0, 1], [1, 0], [0, 2], [1, 1], [1, 2],
];

export interface DoHexCell {
  hex: DoHex;
  /** Cell index in nearness order (0 = under the thumb). */
  cell: number;
  row: number;
  col: number;
  /** Offsets from the honeycomb box's bottom-right corner (px). */
  right: number;
  bottom: number;
}

export interface DoHexLayout {
  cells: DoHexCell[];
  /** The honeycomb box (px): the host sizes its relative box to this. */
  width: number;
  height: number;
}

/** Which cell each hex gets (indices into nearness order), same order as `hexes`. */
export function doHexCellOrder(hexes: readonly DoHex[]): number[] {
  const n = Math.min(hexes.length, DO_HEX_MAX);
  const out: number[] = new Array<number>(n).fill(-1);
  const taken = new Set<number>();
  const mainAt = hexes.slice(0, n).findIndex((h) => h.role === 'main');
  if (mainAt >= 0) { out[mainAt] = 0; taken.add(0); }
  const cancelAt = hexes.slice(0, n).findIndex((h) => h.role === 'cancel');
  if (cancelAt >= 0 && !taken.has(n - 1)) { out[cancelAt] = n - 1; taken.add(n - 1); }
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (out[i] !== -1) continue;
    while (taken.has(next)) next++;
    out[i] = next;
    taken.add(next);
  }
  return out;
}

/** The honeycomb for `hexes` (pure). */
export function doHexLayout(hexes: readonly DoHex[]): DoHexLayout {
  const order = doHexCellOrder(hexes);
  const cells: DoHexCell[] = order.map((cell, i) => {
    const [row, col] = CELLS[cell] as readonly [number, number];
    return {
      hex: hexes[i] as DoHex,
      cell,
      row,
      col,
      right: col * DO_HEX_PITCH + (row === 1 ? DO_HEX_PITCH / 2 : 0),
      bottom: row * DO_HEX_ROW_PITCH,
    };
  });
  let width = 0;
  let height = 0;
  for (const c of cells) {
    width = Math.max(width, c.right + HUD.hex.w);
    height = Math.max(height, c.bottom + HUD.hex.h);
  }
  return { cells, width, height };
}
