import { describe, it, expect } from 'vitest';
import { decideContextMenuPlacement } from './contextMenuPlacement.js';

/**
 * P6.2 (Equinox Phase 6) regression lock — a touch LONG-PRESS during placement
 * must NOT cancel it (Android fires `contextmenu` on long-press; the desktop
 * right-click-cancel affordance was leaking onto mobile → "vibrates then doesn't
 * place"). A MOUSE right-click still cancels. The native menu is suppressed on
 * both while placing.
 */
describe('decideContextMenuPlacement', () => {
  it('not placing → leaves the native menu alone, no cancel', () => {
    expect(decideContextMenuPlacement(false, 'mouse')).toEqual({ preventDefault: false, cancel: false });
    expect(decideContextMenuPlacement(false, 'touch')).toEqual({ preventDefault: false, cancel: false });
  });

  it('placing + MOUSE right-click → suppress menu AND cancel (desktop WS-10)', () => {
    expect(decideContextMenuPlacement(true, 'mouse')).toEqual({ preventDefault: true, cancel: true });
  });

  it('placing + TOUCH long-press → suppress menu but DO NOT cancel (the P6.2 fix)', () => {
    expect(decideContextMenuPlacement(true, 'touch')).toEqual({ preventDefault: true, cancel: false });
  });

  it('placing + pen / unknown → suppress menu, no cancel (only mouse cancels)', () => {
    expect(decideContextMenuPlacement(true, 'pen')).toEqual({ preventDefault: true, cancel: false });
    expect(decideContextMenuPlacement(true, '')).toEqual({ preventDefault: true, cancel: false });
  });
});
