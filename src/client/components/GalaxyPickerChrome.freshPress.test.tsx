/**
 * Owner bug class (phone playtest 2026-11-21): the dial's Map action opens
 * the in-game warp map on touchstart, and the same finger's release (the
 * browser's synthesized click) landed on what was now under it: the map's
 * Close button sits in the same top-right corner as the dial. Inside the warp
 * map only a fresh press counts (a pointerdown in it after it opened, touch at
 * least MENU_ARM_MS after). The Pixi hex tap needs its own canvas pointerdown,
 * so the leftover release never picks a sector (Camera tap classification).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GalaxyPickerChrome } from './GalaxyPickerChrome';
import { MENU_ARM_MS } from './touchClickActivate';

const tapClick = (el: Element): void => { fireEvent.click(el, { detail: 1 }); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('GalaxyPickerChrome (warp map): the opening press never acts inside it', () => {
  it('the leftover release on Close does not close the map; a fresh press does', () => {
    const onClose = vi.fn();
    render(<GalaxyPickerChrome context="warp" activeLimboSectorKey={null} onClose={onClose} />);
    const close = screen.getByTestId('galaxy-warp-close');
    tapClick(close);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(MENU_ARM_MS + 10); });
    fireEvent.pointerDown(close, { pointerType: 'touch' }); tapClick(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the landing map is not guarded (nothing opens it from a held press)', () => {
    const onClose = vi.fn();
    render(<GalaxyPickerChrome activeLimboSectorKey={null} />);
    // No guard: a bare tap click on the landing screen still reaches its target.
    const screenEl = screen.getByTestId('galaxy-map-screen');
    const spy = vi.fn();
    screenEl.addEventListener('click', spy);
    tapClick(screenEl);
    expect(spy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
